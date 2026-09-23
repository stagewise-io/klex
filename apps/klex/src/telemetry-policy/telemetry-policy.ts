/** Process-wide telemetry level, resolved once from CLI arguments and env. */
export type RuntimeTelemetryLevel = 'no' | 'basic' | 'advanced' | 'debug';

/**
 * String-valued span attributes exported at `advanced`. Every entry is an
 * enum, an opaque identifier, or a model/provider/tool name — never free text
 * that could carry user content, paths, or error messages. Numeric and boolean
 * values (counts, durations, token usage, flags) are exported at `advanced`
 * for any non-forbidden, non-content name because they cannot carry private
 * text.
 */
const ADVANCED_STRING_SPAN_ATTRIBUTES = new Set([
  // OpenTelemetry GenAI semantic conventions
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.agent.name',
  'gen_ai.agent.id',
  'gen_ai.conversation.id',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.response.id',
  'gen_ai.response.finish_reasons',
  'gen_ai.tool.name',
  'gen_ai.tool.call.id',
  'gen_ai.tool.type',
  'error.type',
  // Klex model/provider identity
  'klex.model.provider_type',
  'klex.model.provider_id',
  'klex.model.model_id',
  // Klex operation and outcome enums
  'klex.operation.name',
  'klex.outcome',
  'klex.call.source',
  'klex.extension.id',
  'klex.retry.reason',
  'klex.link.type',
  // Klex session identity and state enums
  'klex.session.id',
  'klex.session.name',
  'klex.session.kind',
  'klex.session.extension',
  'klex.session.parent.id',
  'klex.session.child.id',
  'klex.session.child.name',
  'klex.session.child.extension',
  'klex.session.lifecycle.event',
  'klex.session.state.from',
  'klex.session.state.to',
  'klex.session.abort_reason',
  'klex.session.lane_reason',
  'klex.session.created_at',
  'klex.session.closed_at',
  // Turn/step/generation diagnostics (identifiers and enums only)
  'turn.id',
  'step.id',
  'step.modelId',
  'step.finishReason',
  'step.skipReason',
  'step.errorClassification',
  'generation.modelId',
  'generation.finishReason',
  'model.id',
  'error.classification',
  'decision.reason',
  'decision.result',
  'decision.lastMessageRole',
  'repair.type',
  'repair.trigger',
  'inbox.urgency',
  'inbox.drainPoint',
]);

/** Credential-bearing names. Never exported, not even at `debug`. */
const CREDENTIAL_NAME_PATTERN =
  /(?:^|[._-])(?:api[_-]?key|authorization|cookie|credentials?|password|secret|token|headers?)(?:$|[._-])/i;
/** Machine/person-identifying names. Exported only at `debug`. */
const PRIVACY_NAME_PATTERN =
  /(?:^|[._-])(?:host(?:name)?|user(?:name)?|home|mac|ip)(?:$|[._-])/i;
const CONTENT_NAME_PATTERN =
  /(?:^|[._-])(?:prompt|completion|system|tool(?:[._-]call)?[._-]?(?:arguments?|results?|outputs?|inputs?)|messages?|contents?)(?:$|[._-])/i;

export type TelemetryTraceMode = 'none' | 'coarse' | 'detailed' | 'content';
export type TelemetryMetricDetail = 'none' | 'aggregate' | 'detailed';
export type TelemetryLogThreshold = 'OFF' | 'WARN' | 'INFO' | 'TRACE';

export interface TelemetryPolicySnapshot {
  readonly level: RuntimeTelemetryLevel;
  readonly logThreshold: TelemetryLogThreshold;
  readonly traceMode: TelemetryTraceMode;
  readonly metricDetail: TelemetryMetricDetail;
  readonly metricsEnabled: boolean;
  readonly detailedMetricsEnabled: boolean;
  readonly tracesEnabled: boolean;
  readonly detailedTracesEnabled: boolean;
  readonly contentAllowed: boolean;
  readonly identifiersAllowed: boolean;
  readonly inventoryAllowed: boolean;
  readonly telemetryWorkAllowed: boolean;
}

export interface TelemetryPolicy {
  getSnapshot(): TelemetryPolicySnapshot;
  setLevel(level: RuntimeTelemetryLevel): void;
  subscribe(listener: (snapshot: TelemetryPolicySnapshot) => void): () => void;
}

function snapshotForLevel(
  level: RuntimeTelemetryLevel,
): TelemetryPolicySnapshot {
  const enabled = level !== 'no';
  const detailed = level === 'advanced' || level === 'debug';
  return Object.freeze({
    level,
    logThreshold:
      level === 'no'
        ? 'OFF'
        : level === 'basic'
          ? 'WARN'
          : level === 'advanced'
            ? 'INFO'
            : 'TRACE',
    // Traces are a diagnostic signal: `basic` exports metrics and warnings
    // only, never spans.
    traceMode: !detailed
      ? 'none'
      : level === 'advanced'
        ? 'detailed'
        : 'content',
    metricDetail: !enabled ? 'none' : detailed ? 'detailed' : 'aggregate',
    metricsEnabled: enabled,
    detailedMetricsEnabled: detailed,
    tracesEnabled: detailed,
    detailedTracesEnabled: detailed,
    contentAllowed: level === 'debug',
    identifiersAllowed: detailed,
    inventoryAllowed: detailed,
    telemetryWorkAllowed: enabled,
  });
}

class TelemetryPolicyModule implements TelemetryPolicy {
  private snapshot: TelemetryPolicySnapshot;
  private readonly listeners = new Set<
    (snapshot: TelemetryPolicySnapshot) => void
  >();

  constructor(level: RuntimeTelemetryLevel) {
    this.snapshot = snapshotForLevel(level);
  }

  getSnapshot(): TelemetryPolicySnapshot {
    return this.snapshot;
  }

  setLevel(level: RuntimeTelemetryLevel): void {
    if (this.snapshot.level === level) return;
    this.snapshot = snapshotForLevel(level);
    for (const listener of this.listeners) listener(this.snapshot);
  }

  subscribe(listener: (snapshot: TelemetryPolicySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createTelemetryPolicy(
  level: RuntimeTelemetryLevel = 'no',
): TelemetryPolicy {
  return new TelemetryPolicyModule(level);
}

function isNonTextualValue(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => typeof entry === 'number' || typeof entry === 'boolean',
    )
  );
}

/**
 * Span attribute gate.
 *
 * - `no` / `basic`: nothing (traces are not exported).
 * - `advanced`: GenAI/Klex metadata only — allowlisted string attributes plus
 *   numeric/boolean values; never content, credentials, or host/user names.
 * - `debug`: everything except credential-bearing names.
 */
export function isAllowedTelemetryAttribute(
  name: string,
  level: RuntimeTelemetryLevel,
  value?: unknown,
): boolean {
  if (isAlwaysForbiddenTelemetryAttribute(name)) return false;
  if (level === 'debug') return true;
  if (level !== 'advanced') return false;
  if (isPrivacyTelemetryAttribute(name) || isTelemetryContentAttribute(name)) {
    return false;
  }
  return ADVANCED_STRING_SPAN_ATTRIBUTES.has(name) || isNonTextualValue(value);
}

/** Credential-bearing attribute names, rejected at every level. */
export function isAlwaysForbiddenTelemetryAttribute(name: string): boolean {
  return CREDENTIAL_NAME_PATTERN.test(name);
}

/** Host/user-identifying attribute names, exported only at `debug`. */
export function isPrivacyTelemetryAttribute(name: string): boolean {
  return PRIVACY_NAME_PATTERN.test(name);
}

export function isTelemetryContentAttribute(name: string): boolean {
  return CONTENT_NAME_PATTERN.test(name);
}
