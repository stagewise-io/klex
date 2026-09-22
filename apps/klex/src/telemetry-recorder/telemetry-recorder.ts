import type {
  ModelCallUsage,
  SessionTelemetryState,
  TelemetryMetrics,
} from '@/telemetry-metrics';
import type { TelemetryPolicy } from '@/telemetry-policy';

export interface TelemetryRecorder {
  recordModelCall(usage: ModelCallUsage): void;
  registerSession(session: SessionTelemetryState): void;
  unregisterSession(sessionId: string): void;
  updateSession(
    sessionId: string,
    update: Partial<Omit<SessionTelemetryState, 'id' | 'name'>>,
  ): void;
  recordToolCall(sessionId: string, toolName: string, success: boolean): void;
}

class TelemetryRecorderModule implements TelemetryRecorder {
  constructor(
    private readonly metrics: TelemetryMetrics,
    private readonly policy: Readonly<Pick<TelemetryPolicy, 'getSnapshot'>>,
  ) {}

  recordModelCall(usage: ModelCallUsage): void {
    if (!this.policy.getSnapshot().metricsEnabled) return;
    this.metrics.recordModelCall(usage);
  }

  registerSession(session: SessionTelemetryState): void {
    if (!this.policy.getSnapshot().detailedMetricsEnabled) return;
    this.metrics.registerSession(session);
  }

  unregisterSession(sessionId: string): void {
    if (!this.policy.getSnapshot().telemetryWorkAllowed) return;
    this.metrics.unregisterSession(sessionId);
  }

  updateSession(
    sessionId: string,
    update: Partial<Omit<SessionTelemetryState, 'id' | 'name'>>,
  ): void {
    if (!this.policy.getSnapshot().detailedMetricsEnabled) return;
    this.metrics.updateSession(sessionId, update);
  }

  recordToolCall(sessionId: string, toolName: string, success: boolean): void {
    if (!this.policy.getSnapshot().detailedMetricsEnabled) return;
    this.metrics.recordToolCall(sessionId, toolName, success);
  }
}

export function createTelemetryRecorder(
  metrics: TelemetryMetrics,
  policy: Readonly<Pick<TelemetryPolicy, 'getSnapshot'>>,
): TelemetryRecorder {
  return new TelemetryRecorderModule(metrics, policy);
}
