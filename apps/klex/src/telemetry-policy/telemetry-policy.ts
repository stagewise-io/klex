import type { RuntimeTelemetryLevel } from '@/config';

const BASIC_SPAN_ATTRIBUTES = new Set([
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.max_tokens',
  'gen_ai.request.temperature',
  'gen_ai.response.finish_reasons',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.reasoning_tokens',
  'gen_ai.server.time_to_first_token',
  'gen_ai.response.finish_reason',
  'klex.operation.name',
  'klex.outcome',
  'klex.error.category',
  'klex.error.type',
  'error.type',
  'klex.retryable',
]);

const ADVANCED_SPAN_ATTRIBUTES = new Set([
  ...BASIC_SPAN_ATTRIBUTES,
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.tool.name',
  'klex.call.source',
  'klex.extension.id',
  'klex.session.id',
  'klex.session.name',
  'klex.session.extension',
  'klex.session.parent.id',
]);

const FORBIDDEN_NAME_PATTERN =
  /(?:^|[._-])(?:api[_-]?key|authorization|cookie|credentials?|password|secret|token|headers?|host(?:name)?|user(?:name)?|home|mac|ip)(?:$|[._-])/i;
const CONTENT_NAME_PATTERN =
  /(?:^|[._-])(?:prompt|completion|system|tool[_-]?(?:arguments?|results?|outputs?|inputs?)|messages?|contents?)(?:$|[._-])/i;

export type TelemetryTraceMode = 'none' | 'coarse' | 'detailed' | 'content';
export type TelemetryMetricDetail = 'none' | 'aggregate' | 'detailed';
export type TelemetryLogThreshold = 'OFF' | 'WARN' | 'INFO' | 'DEBUG';

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
            : 'DEBUG',
    traceMode:
      level === 'no'
        ? 'none'
        : level === 'basic'
          ? 'coarse'
          : level === 'advanced'
            ? 'detailed'
            : 'content',
    metricDetail: !enabled ? 'none' : detailed ? 'detailed' : 'aggregate',
    metricsEnabled: enabled,
    detailedMetricsEnabled: detailed,
    tracesEnabled: enabled,
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

export function isAllowedTelemetryAttribute(
  name: string,
  level: RuntimeTelemetryLevel = 'basic',
): boolean {
  if (isAlwaysForbiddenTelemetryAttribute(name)) return false;
  if (level === 'debug') return true;
  if (level === 'advanced') return ADVANCED_SPAN_ATTRIBUTES.has(name);
  return level === 'basic' && BASIC_SPAN_ATTRIBUTES.has(name);
}

export function isAlwaysForbiddenTelemetryAttribute(name: string): boolean {
  return FORBIDDEN_NAME_PATTERN.test(name);
}

export function isTelemetryContentAttribute(name: string): boolean {
  return CONTENT_NAME_PATTERN.test(name);
}
