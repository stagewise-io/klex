import { OpenTelemetry } from '@ai-sdk/otel';
import {
  type Span as ApiSpan,
  type Attributes,
  SpanStatusCode,
  type Tracer,
} from '@opentelemetry/api';
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  type GenerateTextAbortEvent,
  type GenerateTextEndEvent,
  type GenerateTextStartEvent,
  type InferTelemetryEvent,
  type LanguageModelCallEndEvent,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  type Telemetry,
} from 'ai';

import type { ModelCallRecord, ModelCallSource } from '@/model-call-logger';
import { normalizeAgentName } from '@/telemetry-resource';

type TelemetryStartEvent = Parameters<NonNullable<Telemetry['onStart']>>[0];
type TelemetryEndEvent = Parameters<NonNullable<Telemetry['onEnd']>>[0];
type OtelStartEvent = Parameters<OpenTelemetry['onStart']>[0];
type OtelEndEvent = Parameters<OpenTelemetry['onEnd']>[0];
type OtelAbortEvent = Parameters<OpenTelemetry['onAbort']>[0];
type EvaluateStartEvent = Parameters<
  NonNullable<Telemetry['experimental_onEvaluateStart']>
>[0];
type EvaluateEndEvent = Parameters<
  NonNullable<Telemetry['experimental_onEvaluateEnd']>
>[0];
type EvaluationCallEndEvent = Parameters<
  NonNullable<Telemetry['experimental_onEvaluationModelCallEnd']>
>[0];
type ReportedUsage = Partial<
  Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'inputTokenDetails'>
>;

/** Sink function that receives a `ModelCallRecord` at the end of every model call. */
export type ModelCallSink = (record: ModelCallRecord) => void;

const TEXT_OPERATIONS = new Set(['ai.streamText', 'ai.generateText']);
const EXTENSION_FUNCTION_PREFIX = 'extension:';

/**
 * Maps AI SDK provider identifiers to OTel semantic convention
 * `gen_ai.provider.name` values. Used for usage metrics; spans use the
 * mapping of `@ai-sdk/otel`.
 */
export function mapProviderName(provider: string): string {
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

/** Klex identity of one AI SDK call, read from the runtime context. */
interface CallIdentity {
  source: ModelCallSource;
  extensionId: string | null;
  conversationId: string | undefined;
  compacted: boolean | undefined;
  providerType: string | undefined;
  providerId: string | undefined;
  modelId: string | undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Provider identity is passed as separate runtime-context values. Native
 * model IDs are opaque and may contain colons, so telemetry must not parse
 * identity out of a composite string. The SDK fields are a fallback for
 * callers that do not allow-list Klex runtime context.
 */
function resolveCallIdentity(event: {
  functionId?: string;
  runtimeContext?: unknown;
  provider?: string;
  modelId?: string;
}): CallIdentity {
  const runtimeContext =
    typeof event.runtimeContext === 'object' && event.runtimeContext !== null
      ? (event.runtimeContext as Record<string, unknown>)
      : undefined;
  const isExtension =
    event.functionId?.startsWith(EXTENSION_FUNCTION_PREFIX) ?? false;
  const compacted = runtimeContext?.['conversation.compacted'];
  return {
    source: isExtension ? 'extension' : 'chat',
    extensionId: isExtension
      ? (event.functionId?.slice(EXTENSION_FUNCTION_PREFIX.length) ?? null)
      : null,
    conversationId: stringField(runtimeContext, 'conversation.id'),
    compacted: typeof compacted === 'boolean' ? compacted : undefined,
    providerType:
      stringField(runtimeContext, 'conversation.providerType') ??
      event.provider,
    providerId:
      stringField(runtimeContext, 'conversation.providerId') ?? event.provider,
    modelId:
      stringField(runtimeContext, 'conversation.modelId') ?? event.modelId,
  };
}

function eventField(event: object, key: string): unknown {
  return key in event ? (event as Record<string, unknown>)[key] : undefined;
}

/** Copies an SDK event, keeping its prototype, with some fields replaced. */
function withFields<T extends object>(event: T, fields: Partial<T>): T {
  const copy: T = Object.create(Object.getPrototypeOf(event));
  return Object.assign(copy, event, fields);
}

// ---------------------------------------------------------------------------
// Spans: @ai-sdk/otel with Klex identity
// ---------------------------------------------------------------------------

export interface KlexOpenTelemetryOptions {
  /** Evaluated per call; content is captured only while this returns true. */
  contentAllowed?: () => boolean;
  /** Configured agent name, recorded as `gen_ai.agent.name`. */
  agentName?: string;
  /** Evaluated per call; stable agent id recorded as `gen_ai.agent.id`. */
  getAgentId?: () => string | null | undefined;
}

/**
 * `@ai-sdk/otel` spans (`invoke_agent` → `step` → `chat` → `execute_tool`)
 * in the GenAI semantic-convention format, plus Klex identity on every span
 * of a call. Grafana Agent Observability keeps `gen_ai.*` content only on
 * spans marked `agento11y.record=true`.
 *
 * Content is captured only while `contentAllowed` returns true, so content
 * is not even serialized below `debug`. `gen_ai.agent.name` is the configured
 * agent name instead of the AI SDK `functionId`.
 */
export class KlexOpenTelemetry extends OpenTelemetry {
  private readonly callAttributes: Map<string, Attributes>;
  private readonly evaluationTracer: Tracer;
  private readonly evaluationSpans = new Map<
    string,
    { span: ApiSpan; recordOutputs: boolean }
  >();
  private readonly agentName: string;
  private readonly contentAllowed: () => boolean;
  private readonly getAgentId: () => string | null | undefined;

  constructor(tracer: Tracer, options: KlexOpenTelemetryOptions = {}) {
    const callAttributes = new Map<string, Attributes>();
    super({
      tracer,
      enrichSpan: ({ callId }) => callAttributes.get(callId),
    });
    this.callAttributes = callAttributes;
    this.evaluationTracer = tracer;
    this.agentName = normalizeAgentName(options.agentName ?? '');
    this.contentAllowed = options.contentAllowed ?? (() => false);
    this.getAgentId = options.getAgentId ?? (() => null);
  }

  private spanAttributes(
    event: OtelStartEvent | EvaluateStartEvent,
  ): Attributes {
    const identity = resolveCallIdentity({
      functionId: event.functionId,
      runtimeContext: eventField(event, 'runtimeContext'),
      provider: stringOrUndefined(eventField(event, 'provider')),
      modelId: stringOrUndefined(eventField(event, 'modelId')),
    });
    const attributes: Attributes = {
      'agento11y.record': true,
      'klex.call.source': identity.source,
      'klex.model.api':
        event.operationId === 'ai.evaluate' ? 'evaluation' : 'generation',
    };
    if (TEXT_OPERATIONS.has(event.operationId)) {
      attributes['gen_ai.request.stream'] =
        event.operationId === 'ai.streamText';
    }
    if (identity.extensionId) {
      attributes['klex.extension.id'] = identity.extensionId;
    }
    const agentId = resolveAgentId(this.getAgentId);
    if (agentId) attributes['gen_ai.agent.id'] = agentId;
    if (identity.conversationId) {
      attributes['gen_ai.conversation.id'] = identity.conversationId;
    }
    if (identity.compacted != null) {
      attributes['klex.conversation.compacted'] = identity.compacted;
    }
    if (identity.providerType) {
      attributes['klex.model.provider_type'] = identity.providerType;
    }
    if (identity.providerId) {
      attributes['klex.model.provider_id'] = identity.providerId;
    }
    if (identity.modelId) attributes['klex.model.model_id'] = identity.modelId;
    return attributes;
  }

  override onStart(event: OtelStartEvent): void {
    this.callAttributes.set(event.callId, this.spanAttributes(event));
    const contentAllowed = this.contentAllowed();
    super.onStart(
      withFields(event, {
        recordInputs: contentAllowed && event.recordInputs !== false,
        recordOutputs: contentAllowed && event.recordOutputs !== false,
        functionId: this.agentName || undefined,
      }),
    );
  }

  override onEnd(event: OtelEndEvent): void {
    super.onEnd(event);
    this.callAttributes.delete(event.callId);
  }

  override onAbort(event: OtelAbortEvent): void {
    super.onAbort(event);
    this.callAttributes.delete(event.callId);
  }

  // Evaluation uses one bounded span with sanitized diagnostics and explicit
  // content gating; the SDK's generic error recorder includes raw exceptions.
  override experimental_onEvaluateStart(event: EvaluateStartEvent): void {
    const attributes: Attributes = {
      ...this.spanAttributes(event),
      'gen_ai.operation.name': 'evaluate',
      'gen_ai.provider.name': mapProviderName(event.provider),
      'gen_ai.request.model': event.modelId,
      'klex.model.api': 'evaluation',
    };
    if (this.agentName) attributes['gen_ai.agent.name'] = this.agentName;
    if (this.contentAllowed() && event.recordInputs !== false) {
      attributes['klex.evaluation.input.content'] = JSON.stringify(event.state);
      attributes['klex.evaluation.questions.content'] = JSON.stringify(
        event.questions,
      );
    }
    this.evaluationSpans.set(event.callId, {
      span: this.evaluationTracer.startSpan('evaluate', { attributes }),
      recordOutputs: this.contentAllowed() && event.recordOutputs !== false,
    });
  }

  override experimental_onEvaluationModelCallEnd(
    event: EvaluationCallEndEvent,
  ): void {
    const state = this.evaluationSpans.get(event.callId);
    if (!state) return;
    if (event.response?.id)
      state.span.setAttribute('gen_ai.response.id', event.response.id);
    if (event.response?.modelId)
      state.span.setAttribute('gen_ai.response.model', event.response.modelId);
    state.span.setAttribute(
      'klex.evaluation.warning_count',
      event.warnings.length,
    );
  }

  override experimental_onEvaluateEnd(event: EvaluateEndEvent): void {
    const state = this.evaluationSpans.get(event.callId);
    if (!state) return;
    this.evaluationSpans.delete(event.callId);
    const { span } = state;
    if (event.usage.inputTokens != null)
      span.setAttribute('gen_ai.usage.input_tokens', event.usage.inputTokens);
    if (event.usage.outputTokens != null)
      span.setAttribute('gen_ai.usage.output_tokens', event.usage.outputTokens);
    span.setAttribute('klex.outcome', 'success');
    if (state.recordOutputs && this.contentAllowed()) {
      span.setAttribute(
        'klex.evaluation.answers.content',
        JSON.stringify(event.answers),
      );
    }
    span.end();
  }

  override onError(error: unknown): void {
    const evaluationCallId =
      typeof error === 'object' && error !== null
        ? eventField(error, 'callId')
        : undefined;
    const evaluation =
      typeof evaluationCallId === 'string'
        ? this.evaluationSpans.get(evaluationCallId)
        : undefined;
    if (evaluation && typeof evaluationCallId === 'string') {
      this.evaluationSpans.delete(evaluationCallId);
      const actual = eventField(error as object, 'error') ?? error;
      const errorType = safeErrorType(actual);
      evaluation.span.setAttributes({
        'error.type': errorType,
        'klex.outcome': errorType === 'AbortError' ? 'aborted' : 'error',
      });
      evaluation.span.setStatus({ code: SpanStatusCode.ERROR });
      evaluation.span.end();
      return;
    }
    super.onError(error);
    const callId =
      typeof error === 'object' && error !== null
        ? eventField(error, 'callId')
        : undefined;
    if (typeof callId === 'string') this.callAttributes.delete(callId);
  }
}

function safeErrorType(error: unknown): string {
  return error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : 'Error';
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveAgentId(
  getAgentId: () => string | null | undefined,
): string | null | undefined {
  try {
    return getAgentId();
  } catch {
    return null;
  }
}

/**
 * Gives GenAI spans that Klex creates itself (session `execute_tool` spans)
 * the Agent Observability marker and identity that {@link KlexOpenTelemetry}
 * puts on AI SDK spans. AI SDK spans carry the marker from the start and are
 * left unchanged. `gen_ai.conversation.id` is the Klex session id, as on AI
 * SDK spans.
 */
export class GenAiIdentitySpanProcessor implements SpanProcessor {
  private readonly getAgentId: () => string | null | undefined;

  constructor(options: Pick<KlexOpenTelemetryOptions, 'getAgentId'> = {}) {
    this.getAgentId = options.getAgentId ?? (() => null);
  }

  onStart(span: Span): void {
    const { attributes } = span;
    if (attributes['gen_ai.operation.name'] === undefined) return;
    if (attributes['agento11y.record'] !== undefined) return;
    span.setAttribute('agento11y.record', true);
    const agentId = resolveAgentId(this.getAgentId);
    if (agentId && attributes['gen_ai.agent.id'] === undefined) {
      span.setAttribute('gen_ai.agent.id', agentId);
    }
    const sessionId = attributes['klex.session.id'];
    if (
      typeof sessionId === 'string' &&
      attributes['gen_ai.conversation.id'] === undefined
    ) {
      span.setAttribute('gen_ai.conversation.id', sessionId);
    }
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Usage records: one ModelCallRecord per terminal generation/evaluation call
// ---------------------------------------------------------------------------

interface UsageCallState {
  identity: CallIdentity;
  api: 'generation' | 'evaluation';
  usage?: ReportedUsage;
  startedAt: number;
  ttftMs: number | undefined;
  totalDurationMs: number | undefined;
}

interface TerminalUsage {
  finishReason: string;
  isError: boolean;
  errorType: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Span-free AI SDK integration that forwards one `ModelCallRecord` per
 * terminal generation or evaluation call (success, error, or abort) to the sink.
 */
export class ModelCallUsageTelemetry implements Telemetry {
  private readonly callStates = new Map<string, UsageCallState>();
  private sink: ModelCallSink | null = null;

  setModelCallSink(sink: ModelCallSink | null): void {
    this.sink = sink;
  }

  onStart(event: TelemetryStartEvent): void {
    if (!TEXT_OPERATIONS.has(event.operationId)) return;
    const textEvent = event as InferTelemetryEvent<GenerateTextStartEvent>;
    this.startCall(textEvent);
  }

  experimental_onEvaluateStart(event: EvaluateStartEvent): void {
    this.startCall(event);
  }

  private startCall(
    event: InferTelemetryEvent<GenerateTextStartEvent> | EvaluateStartEvent,
  ): void {
    this.callStates.set(event.callId, {
      identity: resolveCallIdentity(event),
      api: event.operationId === 'ai.evaluate' ? 'evaluation' : 'generation',
      startedAt: Date.now(),
      ttftMs: undefined,
      totalDurationMs: undefined,
    });
  }

  onLanguageModelCallEnd(
    event: InferTelemetryEvent<LanguageModelCallEndEvent>,
  ): void {
    const state = this.callStates.get(event.callId);
    if (!state) return;
    state.usage = event.usage;
    if (event.performance?.responseTimeMs != null) {
      state.totalDurationMs = event.performance.responseTimeMs;
    }
    if (event.performance?.timeToFirstOutputMs != null) {
      state.ttftMs = event.performance.timeToFirstOutputMs;
    }
  }

  experimental_onEvaluationModelCallEnd(event: EvaluationCallEndEvent): void {
    const state = this.callStates.get(event.callId);
    if (state) state.usage = event.usage;
  }

  experimental_onEvaluateEnd(event: EvaluateEndEvent): void {
    const state = this.callStates.get(event.callId);
    if (!state) return;
    state.usage = event.usage;
    this.finish(event.callId, state, {
      finishReason: 'stop',
      isError: false,
      errorType: null,
    });
  }

  onEnd(event: TelemetryEndEvent): void {
    const state = this.callStates.get(event.callId);
    if (!state) return;
    const { finishReason, usage } =
      event as InferTelemetryEvent<GenerateTextEndEvent>;
    const isError = finishReason === 'error';
    this.finish(event.callId, state, {
      finishReason,
      isError,
      errorType: isError ? 'generation_error' : null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    });
  }

  onAbort(event: InferTelemetryEvent<GenerateTextAbortEvent>): void {
    const state = this.callStates.get(event.callId);
    if (!state) return;
    this.finish(event.callId, state, {
      finishReason: 'aborted',
      isError: true,
      errorType: 'aborted',
    });
  }

  onError(error: unknown): void {
    if (typeof error !== 'object' || error === null) return;
    const callId = eventField(error, 'callId');
    if (typeof callId !== 'string') return;
    const state = this.callStates.get(callId);
    if (!state) return;
    const actual = eventField(error, 'error') ?? error;
    if (NoObjectGeneratedError.isInstance(actual)) state.usage = actual.usage;
    const errorType = safeErrorType(actual);
    this.finish(callId, state, {
      finishReason: errorType === 'AbortError' ? 'aborted' : 'error',
      isError: true,
      errorType,
    });
  }

  /** Forwards the record once per call. Fire-and-forget; never throws. */
  private finish(
    callId: string,
    state: UsageCallState,
    usage: TerminalUsage,
  ): void {
    this.callStates.delete(callId);
    if (!this.sink) return;
    const now = Date.now();
    const { identity } = state;
    const inputTokens = usage.inputTokens ?? state.usage?.inputTokens;
    const outputTokens = usage.outputTokens ?? state.usage?.outputTokens;
    const cacheWriteTokens =
      usage.cacheWriteTokens ??
      state.usage?.inputTokenDetails?.cacheWriteTokens;
    const cacheReadTokens =
      usage.cacheReadTokens ?? state.usage?.inputTokenDetails?.cacheReadTokens;
    try {
      this.sink({
        id: callId,
        sessionId: identity.conversationId ?? null,
        api: state.api,
        tokenUsageReported: inputTokens != null && outputTokens != null,
        cacheUsageReported: cacheWriteTokens != null && cacheReadTokens != null,
        providerType: identity.providerType ?? 'unknown',
        providerId: identity.providerId ?? 'unknown',
        endpointId: null,
        modelId: identity.modelId ?? 'unknown',
        source: identity.source,
        extensionId: identity.extensionId,
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        inputCacheWriteTokens: cacheWriteTokens ?? 0,
        inputCacheReadTokens: cacheReadTokens ?? 0,
        ttftMs: state.ttftMs ?? null,
        // The SDK's response time when available; wall-clock duration for
        // abort and error paths that carry no performance data.
        totalDurationMs: state.totalDurationMs ?? now - state.startedAt,
        finishReason: usage.finishReason,
        isError: usage.isError,
        errorType: usage.errorType,
        startedAt: new Date(state.startedAt).toISOString(),
        finishedAt: new Date(now).toISOString(),
      });
    } catch {
      // Fire-and-forget — never propagate sink errors.
    }
  }
}
