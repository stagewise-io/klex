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
} from 'ai';

import type { ModelCallRecord, ModelCallSource } from '@/model-call-logger';

// Extract the exact event types the Telemetry interface expects for
// onStart / onEnd. These are unions (OperationStartEvent / OperationEndEvent)
// that the `ai` package does not export directly.
type TelemetryStartEvent = Parameters<NonNullable<Telemetry['onStart']>>[0];
type TelemetryEndEvent = Parameters<NonNullable<Telemetry['onEnd']>>[0];

/** Sink function that receives a `ModelCallRecord` at the end of every model call. */
export type ModelCallSink = (record: ModelCallRecord) => void;

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
  /** Telemetry options saved from the `onStart` event. */
  recordOutputs: boolean;
  functionId: string | undefined;
  operationId: string;
  /** Session UUID from runtimeContext — set on root span as gen_ai.conversation.id. */
  conversationId: string | undefined;
  /** Full klex modelId (providerId:endpointId:modelId) from runtimeContext. */
  fullModelId: string | undefined;
  /** Provider ID extracted from fullModelId. */
  providerId: string | undefined;
  /** Endpoint ID extracted from fullModelId. */
  endpointId: string | undefined;
  /** Model ID (final segment of fullModelId). */
  modelIdOnly: string | undefined;
  /** Wall-clock timestamp (ms) when onStart fired. */
  spanStartTime: number;
  /** Time to first token in ms, set in onLanguageModelCallEnd. */
  ttftMs: number | undefined;
  /** Total response time in ms, set in onLanguageModelCallEnd. */
  totalDurationMs: number | undefined;
}

// ---------------------------------------------------------------------------
// KlexTelemetry
// ---------------------------------------------------------------------------

/**
 * Custom AI SDK `Telemetry` integration that creates spans fitting the
 * klex trace hierarchy: `session → turn → step → generate_content`.
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
 * - `onStepStart` / `onStepEnd` are no-ops — the klex `step` span is
 *   managed by `step.ts` and there is no multi-step tool loop (tools are
 *   passed without `execute`).
 * - Tool execution events are implemented for completeness but will not fire
 *   in the current architecture (tools have no `execute` function).
 * - `onError` records the error on all open spans, including the OTel
 *   `error.type` attribute.
 *
 * All attribute keys follow the OTel gen_ai semantic conventions.
 */
export class KlexTelemetry implements Telemetry {
  private readonly callStates = new Map<string, CallState>();
  private modelCallSink: ModelCallSink | null = null;

  constructor(private readonly tracer: Tracer) {}

  private getCallState(callId: string): CallState | undefined {
    return this.callStates.get(callId);
  }

  private cleanupCallState(callId: string): void {
    this.callStates.delete(callId);
  }

  /** Register a sink that receives a `ModelCallRecord` at the end of every model call. */
  setModelCallSink(sink: ModelCallSink | null): void {
    this.modelCallSink = sink;
  }

  /**
   * Builds a `ModelCallRecord` from `CallState` and forwards it to the sink.
   * Fire-and-forget — never throws.
   */
  private forwardModelCallRecord(
    callId: string,
    state: CallState,
    finishReason: string,
    isError: boolean,
    errorType: string | null,
    inputTokens: number,
    outputTokens: number,
    cacheWriteTokens: number,
    cacheReadTokens: number,
  ): void {
    if (!this.modelCallSink) return;

    // Derive source and extensionId from functionId.
    // functionId patterns: 'chat-session', 'extension:<id>', or undefined.
    const functionId = state.functionId;
    let source: ModelCallSource = 'chat';
    let extensionId: string | null = null;
    if (functionId?.startsWith('extension:')) {
      source = 'extension';
      extensionId = functionId.slice('extension:'.length);
    }

    const now = Date.now();
    const record: ModelCallRecord = {
      id: callId,
      sessionId: state.conversationId ?? null,
      providerId: state.providerId ?? 'unknown',
      endpointId: state.endpointId ?? null,
      modelId: state.modelIdOnly ?? state.fullModelId ?? 'unknown',
      source,
      extensionId,
      inputTokens,
      outputTokens,
      inputCacheWriteTokens: cacheWriteTokens,
      inputCacheReadTokens: cacheReadTokens,
      ttftMs: state.ttftMs ?? null,
      // Use the AI SDK's responseTimeMs when available; fall back to
      // wall-clock duration for abort/error paths (no performance data).
      totalDurationMs: state.totalDurationMs ?? now - state.spanStartTime,
      finishReason,
      isError,
      errorType,
      startedAt: new Date(state.spanStartTime).toISOString(),
      finishedAt: new Date(now).toISOString(),
    };

    try {
      this.modelCallSink(record);
    } catch {
      // Fire-and-forget — never propagate sink errors.
    }
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
    // The full klex modelId (providerId:endpointId:modelId) is passed
    // via runtimeContext by the session. The AI SDK's restricted telemetry
    // dispatcher strips runtime context keys unless the caller explicitly
    // allow-lists them via telemetry.includeRuntimeContext. If that was
    // not configured, fall back to the AI SDK's internal provider/modelId
    // fields so we still capture something useful.
    const fullModelId =
      typeof runtimeContext?.['conversation.modelId'] === 'string'
        ? (runtimeContext['conversation.modelId'] as string)
        : undefined;
    const requestModel = fullModelId ?? genEvent.modelId;

    // Parse the klex fullModelId (format: providerId:endpointId:modelId
    // or providerId:modelId) to extract individual components for trace
    // metadata. This lets traces be filtered/grouped by provider and endpoint.
    // Uses indexOf/slice (not split) so model IDs containing colons survive.
    // The config layer uses the same approach in splitProviderId/resolveModel.
    let providerId: string | undefined;
    let endpointId: string | undefined;
    let modelIdOnly: string | undefined;
    if (fullModelId) {
      const firstColon = fullModelId.indexOf(':');
      if (firstColon !== -1) {
        providerId = fullModelId.slice(0, firstColon);
        const rest = fullModelId.slice(firstColon + 1);
        const secondColon = rest.indexOf(':');
        if (secondColon !== -1) {
          // providerId:endpointId:modelId (manual provider)
          endpointId = rest.slice(0, secondColon);
          modelIdOnly = rest.slice(secondColon + 1);
        } else {
          // providerId:modelId (preset provider, no endpoint)
          modelIdOnly = rest;
        }
      }
    } else {
      // Fall back to the AI SDK's own provider/modelId fields when the
      // runtime context was stripped by the restricted telemetry dispatcher.
      // These are the bare names (e.g. provider="openai", modelId="gpt-4o")
      // so they won't include endpoint information, but they prevent
      // modelId from being logged as "unknown".
      providerId = genEvent.provider;
      modelIdOnly = genEvent.modelId;
    }

    const spanName = `generate_content ${requestModel}`;

    const attributes: Attributes = {
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.system': providerName,
      'gen_ai.provider.name': providerName,
      'gen_ai.request.model': requestModel,
      'gen_ai.request.stream': genEvent.operationId === 'ai.streamText',
      'gen_ai.agent.name': genEvent.functionId,
    };

    // Klex-agent-specific metadata: provider and endpoint IDs from the
    // full model ID. These allow traces to be filtered by provider/endpoint
    // in the tracing backend.
    if (providerId != null) {
      attributes['klex.model.provider_id'] = providerId;
    }
    if (endpointId != null) {
      attributes['klex.model.endpoint_id'] = endpointId;
    }
    if (modelIdOnly != null) {
      attributes['klex.model.model_id'] = modelIdOnly;
    }

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

    this.callStates.set(genEvent.callId, {
      rootSpan,
      rootContext,
      recordOutputs: genEvent.recordOutputs !== false,
      functionId: genEvent.functionId,
      operationId: genEvent.operationId,
      conversationId,
      fullModelId,
      providerId,
      endpointId,
      modelIdOnly,
      spanStartTime: Date.now(),
      ttftMs: undefined,
      totalDurationMs: undefined,
    });
  }

  // --- Step lifecycle (no-op) -----------------------------------------------

  onStepStart(_event: InferTelemetryEvent<GenerateTextStepStartEvent>): void {
    // No-op: the klex step span is managed by step.ts.
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
      // Use the full klex modelId if available; fall back to the
      // AI SDK's internal response model name.
      'gen_ai.response.model': state.fullModelId ?? event.modelId,
    });

    // Performance attributes — only available at model-call end.
    if (event.performance) {
      const perfAttrs: Attributes = {};
      if (event.performance.responseTimeMs != null) {
        perfAttrs['gen_ai.client.operation.duration'] = msToSeconds(
          event.performance.responseTimeMs,
        );
        state.totalDurationMs = event.performance.responseTimeMs;
      }
      if (event.performance.timeToFirstOutputMs != null) {
        perfAttrs['gen_ai.response.time_to_first_chunk'] = msToSeconds(
          event.performance.timeToFirstOutputMs,
        );
        state.ttftMs = event.performance.timeToFirstOutputMs;
      }
      span.setAttributes(perfAttrs);
    }
  }

  // --- Operation end --------------------------------------------------------

  onEnd(event: TelemetryEndEvent): void {
    const state = this.getCallState(event.callId);
    if (!state?.rootSpan) return;

    // Only record text-generation-specific attributes and forward model call records.
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

      // Forward model call record to the sink (if registered).
      this.forwardModelCallRecord(
        event.callId,
        state,
        textEndEvent.finishReason,
        textEndEvent.finishReason === 'error',
        textEndEvent.finishReason === 'error' ? 'generation_error' : null,
        textEndEvent.usage.inputTokens ?? 0,
        textEndEvent.usage.outputTokens ?? 0,
        textEndEvent.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        textEndEvent.usage.inputTokenDetails?.cacheReadTokens ?? 0,
      );
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

    // Record partial output from completed steps so traces show what
    // was generated before the abort. Each step's text, tool calls, and
    // content are serialized into gen_ai.output.messages.
    if (state.recordOutputs && event.steps.length > 0) {
      const outputMessages = event.steps.map((step) => {
        const msg: Record<string, unknown> = {
          role: 'assistant',
          content: step.content,
          text: step.text,
        };
        if (step.toolCalls && step.toolCalls.length > 0) {
          msg.toolCalls = step.toolCalls;
        }
        return msg;
      });
      const serialized = serializeJson(outputMessages);
      if (serialized != null) {
        state.rootSpan.setAttribute('gen_ai.output.messages', serialized);
      }
    }

    // Record abort reason if available.
    if (event.reason != null) {
      const reasonStr =
        event.reason instanceof Error
          ? `${event.reason.name}: ${event.reason.message}`
          : String(event.reason);
      state.rootSpan.setAttribute('gen_ai.abort.reason', reasonStr);
    }

    // Forward model call record to the sink (if registered).
    this.forwardModelCallRecord(
      event.callId,
      state,
      'aborted',
      true,
      'aborted',
      0,
      0,
      0,
      0,
    );

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

    recordErrorOnSpan(state.rootSpan, actualError);

    // Forward model call record to the sink (if registered).
    // Best-effort: if onEnd already forwarded a record for this callId,
    // the PRIMARY KEY constraint in SQLite silently rejects the duplicate.
    const errorType =
      actualError instanceof Error ? actualError.name : String(actualError);
    this.forwardModelCallRecord(
      maybeEvent.callId,
      state,
      'error',
      true,
      errorType,
      0,
      0,
      0,
      0,
    );

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
 * context (the klex step context).  Register globally via
 * `registerTelemetry(createKlexTelemetry(tracer))`.
 */
export function createKlexTelemetry(tracer: Tracer): KlexTelemetry {
  return new KlexTelemetry(tracer);
}
