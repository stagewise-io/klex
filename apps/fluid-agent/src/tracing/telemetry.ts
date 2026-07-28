import {
  type Attributes,
  type Context,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import type {
  GenerateTextAbortEvent,
  GenerateTextEndEvent,
  GenerateTextStartEvent,
  GenerateTextStepEndEvent,
  GenerateTextStepStartEvent,
  InferTelemetryEvent,
  Instructions,
  LanguageModelCallEndEvent,
  LanguageModelCallStartEvent,
  Telemetry,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from 'ai';

// Extract the exact event types the Telemetry interface expects for
// onStart / onEnd. These are unions (OperationStartEvent / OperationEndEvent)
// that the `ai` package does not export directly.
type TelemetryStartEvent = Parameters<NonNullable<Telemetry['onStart']>>[0];
type TelemetryEndEvent = Parameters<NonNullable<Telemetry['onEnd']>>[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serializes a value to a JSON string for OTel opt-in content attributes.
 * Returns `undefined` when the value is absent or serialization fails.
 */
function serializeJson(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Converts an `Instructions` value (string, SystemModelMessage, or array)
 * to a plain string suitable for `gen_ai.system_instructions`.
 */
function instructionsToString(
  instructions: Instructions | undefined,
): string | undefined {
  if (instructions == null) return undefined;
  if (typeof instructions === 'string') return instructions;
  // SystemModelMessage or SystemModelMessage[] — serialize to JSON.
  return serializeJson(instructions);
}

/**
 * Extracts tool definitions (name, description, input schema) from a tool set,
 * stripping execute functions and other runtime fields that are not relevant
 * for `gen_ai.tool.definitions`.
 */
function toolsToDefinitions(
  tools: Record<string, unknown> | undefined,
): unknown[] | undefined {
  if (tools == null || Object.keys(tools).length === 0) return undefined;
  return Object.entries(tools).map(([name, tool]) => {
    const t = tool as Record<string, unknown>;
    return {
      name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    };
  });
}

/**
 * Maps AI SDK provider identifiers to OTel semantic convention `gen_ai.system`
 * values.
 */
function mapProviderName(provider: string): string {
  const lower = provider.toLowerCase();
  const prefixes: [string, string][] = [
    ['google.vertex', 'gcp.vertex_ai'],
    ['google.generative-ai', 'gcp.gemini'],
    ['google-vertex', 'gcp.vertex_ai'],
    ['amazon-bedrock', 'aws.bedrock'],
    ['azure-openai', 'azure.ai.openai'],
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['azure', 'azure.ai.inference'],
    ['google', 'gcp.gemini'],
    ['mistral', 'mistral_ai'],
    ['cohere', 'cohere'],
    ['bedrock', 'aws.bedrock'],
    ['groq', 'groq'],
    ['deepseek', 'deepseek'],
    ['perplexity', 'perplexity'],
    ['xai', 'x_ai'],
    ['openrouter', 'openrouter'],
    ['together', 'together'],
    ['fireworks', 'fireworks'],
    ['fireworks-ai', 'fireworks'],
    ['ollama', 'ollama'],
    ['lmstudio', 'lmstudio'],
  ];
  for (const [prefix, mapped] of prefixes) {
    if (
      lower === prefix ||
      lower.startsWith(`${prefix}.`) ||
      lower.startsWith(`${prefix}-`)
    ) {
      return mapped;
    }
  }
  return provider;
}

/** Converts milliseconds to seconds for OTel duration attributes. */
function msToSeconds(ms: number | undefined): number | undefined {
  return ms == null ? undefined : ms / 1_000;
}

/**
 * Records an error on a span, including the OTel `error.type` attribute.
 *
 * Sets `error.type`, records the exception, and marks the span status as
 * ERROR so that failing operations are visible in tracing backends.
 */
export function recordErrorOnSpan(span: Span, error: unknown): void {
  let errorType: string | undefined;
  if (error instanceof Error) {
    errorType = error.name;
    span.recordException({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    errorType = String(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  // OTel gen_ai semantic convention: error.type SHOULD match the error code
  // or canonical exception name.
  span.setAttribute('error.type', errorType);
}

// ---------------------------------------------------------------------------
// Call state
// ---------------------------------------------------------------------------

interface CallState {
  /** Root operation span — `generate_content {modelId}`. */
  rootSpan: Span;
  rootContext: Context;
  /** Tool-execution spans keyed by `toolCallId`. */
  toolSpans: Map<string, { span: Span; context: Context }>;
  /** Telemetry options saved from the `onStart` event. */
  recordInputs: boolean;
  recordOutputs: boolean;
  functionId: string | undefined;
  operationId: string;
  /** Session UUID from runtimeContext — set on root span as gen_ai.conversation.id. */
  conversationId: string | undefined;
  /** Whether the history was compacted — set as gen_ai.conversation.compacted. */
  compacted: boolean | undefined;
  /** Tool descriptions keyed by tool name, extracted from the tool set in onStart. */
  toolDescriptions: Map<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// FluidTelemetry
// ---------------------------------------------------------------------------

/**
 * Custom AI SDK `Telemetry` integration that creates spans fitting the
 * fluid-agent trace hierarchy: `session → turn → step → generate_content`.
 *
 * - `onStart` creates a `generate_content {modelId}` span as a child of the
 *   active context (the step context). It reads `conversation.id` and
 *   `conversation.compacted` from the `runtimeContext` to set
 *   `gen_ai.conversation.id` and `gen_ai.conversation.compacted` attributes.
 * - `onLanguageModelCallStart` is a no-op — the single root span replaces
 *   the redundant model-call span.
 * - `executeLanguageModelCall` runs the provider call within the root span's
 *   context so the SDK's internal HTTP spans nest correctly.
 * - `onLanguageModelCallEnd` records response id, response model, usage,
 *   finish reasons, cache tokens, and performance metrics on the root span.
 * - `onStepStart` / `onStepEnd` are no-ops — the fluid-agent `step` span is
 *   managed by `step.ts` and there is no multi-step tool loop (tools are
 *   passed without `execute`).
 * - Tool execution events are implemented for completeness but will not fire
 *   in the current architecture (tools have no `execute` function).
 * - `onError` records the error on all open spans, including the OTel
 *   `error.type` attribute.
 *
 * All attribute keys follow the OTel gen_ai semantic conventions.
 */
class FluidTelemetry implements Telemetry {
  private readonly callStates = new Map<string, CallState>();

  constructor(private readonly tracer: Tracer) {}

  private getCallState(callId: string): CallState | undefined {
    return this.callStates.get(callId);
  }

  private cleanupCallState(callId: string): void {
    this.callStates.delete(callId);
  }

  // --- Operation lifecycle --------------------------------------------------

  onStart(event: TelemetryStartEvent): void {
    // Only instrument text generation operations.
    if (
      event.operationId !== 'ai.streamText' &&
      event.operationId !== 'ai.generateText'
    ) {
      return;
    }

    // Narrow to the text-generation-specific event shape.
    const genEvent = event as InferTelemetryEvent<GenerateTextStartEvent>;

    const providerName = mapProviderName(genEvent.provider);
    const spanName = `generate_content ${genEvent.modelId}`;

    // Extract conversation metadata from runtimeContext.
    const runtimeContext = genEvent.runtimeContext as
      | Record<string, unknown>
      | undefined;
    const conversationId =
      typeof runtimeContext?.['conversation.id'] === 'string'
        ? (runtimeContext['conversation.id'] as string)
        : undefined;
    const compacted =
      typeof runtimeContext?.['conversation.compacted'] === 'boolean'
        ? (runtimeContext['conversation.compacted'] as boolean)
        : undefined;

    const attributes: Attributes = {
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.system': providerName,
      'gen_ai.provider.name': providerName,
      'gen_ai.request.model': genEvent.modelId,
      'gen_ai.request.stream': genEvent.operationId === 'ai.streamText',
      'gen_ai.agent.name': genEvent.functionId,
    };

    // Conversation metadata from runtimeContext.
    if (conversationId != null) {
      attributes['gen_ai.conversation.id'] = conversationId;
    }
    if (compacted != null) {
      attributes['gen_ai.conversation.compacted'] = compacted;
    }

    // Optional request parameters from LanguageModelCallOptions.
    if (genEvent.maxOutputTokens != null) {
      attributes['gen_ai.request.max_tokens'] = genEvent.maxOutputTokens;
    }
    if (genEvent.temperature != null) {
      attributes['gen_ai.request.temperature'] = genEvent.temperature;
    }
    if (genEvent.topP != null) {
      attributes['gen_ai.request.top_p'] = genEvent.topP;
    }
    if (genEvent.topK != null) {
      attributes['gen_ai.request.top_k'] = genEvent.topK;
    }
    if (genEvent.presencePenalty != null) {
      attributes['gen_ai.request.presence_penalty'] = genEvent.presencePenalty;
    }
    if (genEvent.frequencyPenalty != null) {
      attributes['gen_ai.request.frequency_penalty'] =
        genEvent.frequencyPenalty;
    }

    // Opt-in content attributes (gen_ai semantic conventions).
    // Only recorded when telemetry.recordInputs is not false.
    const recordInputs = genEvent.recordInputs !== false;
    if (recordInputs) {
      const systemInstructions = instructionsToString(genEvent.instructions);
      if (systemInstructions != null) {
        attributes['gen_ai.system_instructions'] = systemInstructions;
      }

      const inputMessages = serializeJson(genEvent.messages);
      if (inputMessages != null) {
        attributes['gen_ai.input.messages'] = inputMessages;
      }

      const toolDefs = toolsToDefinitions(
        genEvent.tools as Record<string, unknown> | undefined,
      );
      if (toolDefs != null) {
        attributes['gen_ai.tool.definitions'] = serializeJson(toolDefs);
      }
    }

    const rootSpan = this.tracer.startSpan(spanName, {
      attributes,
      kind: SpanKind.INTERNAL,
    });

    // Inherit the active context (the step context) as parent.
    const rootContext = trace.setSpan(context.active(), rootSpan);

    // Extract tool descriptions from the tool set for use in execute_tool spans.
    const toolDescriptions = new Map<string, string | undefined>();
    const tools = genEvent.tools as Record<string, unknown> | undefined;
    if (tools != null) {
      for (const [name, tool] of Object.entries(tools)) {
        const t = tool as Record<string, unknown>;
        if (typeof t.description === 'string') {
          toolDescriptions.set(name, t.description);
        }
      }
    }

    this.callStates.set(genEvent.callId, {
      rootSpan,
      rootContext,
      toolSpans: new Map(),
      recordInputs: genEvent.recordInputs !== false,
      recordOutputs: genEvent.recordOutputs !== false,
      functionId: genEvent.functionId,
      operationId: genEvent.operationId,
      conversationId,
      compacted,
      toolDescriptions,
    });
  }

  // --- Step lifecycle (no-op) -----------------------------------------------

  onStepStart(_event: InferTelemetryEvent<GenerateTextStepStartEvent>): void {
    // No-op: the fluid-agent step span is managed by step.ts.
    // The AI SDK's internal step concept is redundant here because tools
    // are passed without execute — there is no multi-step tool loop.
  }

  onStepEnd(_event: InferTelemetryEvent<GenerateTextStepEndEvent>): void {
    // No-op: see onStepStart.
  }

  // --- Model call lifecycle -------------------------------------------------

  onLanguageModelCallStart(
    _event: InferTelemetryEvent<LanguageModelCallStartEvent>,
  ): void {
    // No-op: the single root span replaces the redundant model-call span.
    // Provider-specific request attributes are already set on the root span
    // in onStart. The HTTP call runs in the root context via
    // executeLanguageModelCall so the SDK's internal HTTP spans nest
    // correctly under the root span.
  }

  executeLanguageModelCall<T>(options: {
    callId: string;
    execute: () => PromiseLike<T>;
  }): PromiseLike<T> {
    const state = this.getCallState(options.callId);
    const ctx = state?.rootContext ?? context.active();
    return context.with(ctx, options.execute);
  }

  onLanguageModelCallEnd(
    event: InferTelemetryEvent<LanguageModelCallEndEvent>,
  ): void {
    const state = this.getCallState(event.callId);
    if (!state?.rootSpan) return;

    const span = state.rootSpan;

    span.setAttributes({
      'gen_ai.response.id': event.responseId,
      'gen_ai.response.model': event.modelId,
    });

    // Performance attributes — only available at model-call end.
    if (event.performance) {
      const perfAttrs: Attributes = {};
      if (event.performance.responseTimeMs != null) {
        perfAttrs['gen_ai.client.operation.duration'] = msToSeconds(
          event.performance.responseTimeMs,
        );
      }
      if (event.performance.timeToFirstOutputMs != null) {
        perfAttrs['gen_ai.response.time_to_first_chunk'] = msToSeconds(
          event.performance.timeToFirstOutputMs,
        );
      }
      span.setAttributes(perfAttrs);
    }
  }

  // --- Tool execution lifecycle --------------------------------------------

  onToolExecutionStart(
    event: InferTelemetryEvent<ToolExecutionStartEvent>,
  ): void {
    const state = this.getCallState(event.callId);
    if (!state) return;

    const { toolCall } = event;
    const spanName = `execute_tool ${toolCall.toolName}`;

    const attributes: Attributes = {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': toolCall.toolName,
      'gen_ai.tool.call.id': toolCall.toolCallId,
      'gen_ai.tool.type': 'function',
    };

    // Tool description from the original tool definition (if present).
    const description = state.toolDescriptions.get(toolCall.toolName);
    if (description != null) {
      attributes['gen_ai.tool.description'] = description;
    }

    // Opt-in content attribute: tool call arguments.
    if (state.recordInputs) {
      const args = serializeJson(toolCall.input);
      if (args != null) {
        attributes['gen_ai.tool.call.arguments'] = args;
      }
    }

    const toolSpan = this.tracer.startSpan(
      spanName,
      {
        attributes,
        kind: SpanKind.INTERNAL,
      },
      state.rootContext,
    );

    const toolContext = trace.setSpan(state.rootContext, toolSpan);
    state.toolSpans.set(toolCall.toolCallId, {
      span: toolSpan,
      context: toolContext,
    });
  }

  executeTool<T>(options: {
    callId: string;
    toolCallId: string;
    execute: () => PromiseLike<T>;
  }): PromiseLike<T> {
    const state = this.getCallState(options.callId);
    const entry = state?.toolSpans.get(options.toolCallId);
    if (!entry) return options.execute();

    return context.with(entry.context, async () => {
      try {
        return await options.execute();
      } catch (error) {
        // Record the error on the span so it surfaces even if the SDK's
        // normal onToolExecutionEnd path is not reached.
        recordErrorOnSpan(entry.span, error);
        throw error;
      }
    });
  }

  onToolExecutionEnd(event: InferTelemetryEvent<ToolExecutionEndEvent>): void {
    const state = this.getCallState(event.callId);
    if (!state) return;

    const entry = state.toolSpans.get(event.toolCall.toolCallId);
    if (!entry) return;

    const { span } = entry;

    const durationSec = msToSeconds(event.toolExecutionMs);
    if (durationSec != null) {
      span.setAttribute('gen_ai.execute_tool.duration', durationSec);
    }

    if (event.toolOutput.type === 'tool-error') {
      recordErrorOnSpan(span, event.toolOutput.error);
    } else if (event.toolOutput.type === 'tool-result') {
      // Opt-in content attribute: tool call result.
      if (state.recordOutputs) {
        const result = serializeJson(event.toolOutput.output);
        if (result != null) {
          span.setAttribute('gen_ai.tool.call.result', result);
        }
      }
    }

    span.end();
    state.toolSpans.delete(event.toolCall.toolCallId);
  }

  // --- Operation end --------------------------------------------------------

  onEnd(event: TelemetryEndEvent): void {
    const state = this.getCallState(event.callId);
    if (!state?.rootSpan) return;

    // Only record text-generation-specific attributes.
    if (
      state.operationId === 'ai.streamText' ||
      state.operationId === 'ai.generateText'
    ) {
      const textEndEvent = event as InferTelemetryEvent<GenerateTextEndEvent>;

      state.rootSpan.setAttributes({
        'gen_ai.response.finish_reasons': [textEndEvent.finishReason],
        'gen_ai.usage.input_tokens': textEndEvent.usage.inputTokens,
        'gen_ai.usage.output_tokens': textEndEvent.usage.outputTokens,
      });

      // Set error.type when the generation ended in an error state.
      if (textEndEvent.finishReason === 'error') {
        state.rootSpan.setAttribute('error.type', 'generation_error');
        state.rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      }

      if (textEndEvent.usage.inputTokenDetails?.cacheReadTokens != null) {
        state.rootSpan.setAttribute(
          'gen_ai.usage.cache_read.input_tokens',
          textEndEvent.usage.inputTokenDetails.cacheReadTokens,
        );
      }
      if (textEndEvent.usage.inputTokenDetails?.cacheWriteTokens != null) {
        state.rootSpan.setAttribute(
          'gen_ai.usage.cache_creation.input_tokens',
          textEndEvent.usage.inputTokenDetails.cacheWriteTokens,
        );
      }

      // Opt-in content attribute: gen_ai.output.messages
      // Only recorded when telemetry.recordOutputs is not false.
      if (state.recordOutputs) {
        // Build a minimal output message from the response content.
        const outputMessage: Record<string, unknown> = {
          role: 'assistant',
          content: textEndEvent.content,
        };
        if (textEndEvent.text) {
          outputMessage.text = textEndEvent.text;
        }
        if (textEndEvent.toolCalls && textEndEvent.toolCalls.length > 0) {
          outputMessage.toolCalls = textEndEvent.toolCalls;
        }
        const outputMessages = serializeJson([outputMessage]);
        if (outputMessages != null) {
          state.rootSpan.setAttribute('gen_ai.output.messages', outputMessages);
        }
      }
    }

    state.rootSpan.end();
    this.cleanupCallState(event.callId);
  }

  // --- Abort & error --------------------------------------------------------

  onAbort(event: InferTelemetryEvent<GenerateTextAbortEvent>): void {
    const state = this.getCallState(event.callId);
    if (!state) return;

    // Mark the generation as aborted on the root span.
    state.rootSpan.setAttribute('gen_ai.response.finish_reasons', ['aborted']);
    state.rootSpan.setAttribute('error.type', 'aborted');
    state.rootSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: 'Generation aborted',
    });

    // End any open tool spans.
    for (const { span } of state.toolSpans.values()) {
      span.end();
    }
    state.toolSpans.clear();

    state.rootSpan.end();
    this.cleanupCallState(event.callId);
  }

  onError(error: unknown): void {
    const maybeEvent = error as
      | { callId?: string; error?: unknown }
      | undefined;
    if (!maybeEvent?.callId) return;

    const state = this.getCallState(maybeEvent.callId);
    if (!state) return;

    const actualError = maybeEvent.error ?? error;

    for (const { span } of state.toolSpans.values()) {
      recordErrorOnSpan(span, actualError);
      span.end();
    }
    state.toolSpans.clear();

    recordErrorOnSpan(state.rootSpan, actualError);
    state.rootSpan.end();
    this.cleanupCallState(maybeEvent.callId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a custom `Telemetry` integration for the AI SDK.
 *
 * Uses the provided tracer to create spans that nest under the active OTel
 * context (the fluid-agent step context).  Register globally via
 * `registerTelemetry(createFluidTelemetry(tracer))`.
 */
export function createFluidTelemetry(tracer: Tracer): Telemetry {
  return new FluidTelemetry(tracer);
}
