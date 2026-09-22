import { describe, expect, it, vi } from 'vitest';

import type { TelemetryMetrics } from '@/telemetry-metrics';
import { createTelemetryPolicy } from '@/telemetry-policy';

import { createTelemetryRecorder } from './telemetry-recorder';

function createMetricsSpy() {
  return {
    recordModelCall: vi.fn(),
    registerSession: vi.fn(),
    unregisterSession: vi.fn(),
    updateSession: vi.fn(),
    recordToolCall: vi.fn(),
  } as unknown as TelemetryMetrics;
}

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  inputCacheReadTokens: 0,
  inputCacheWriteTokens: 0,
};

const session = {
  id: 'session-1',
  name: 'session',
  kind: 'default' as const,
  active: true,
  runtimeState: 'idle',
  historyLength: 0,
  transformedHistoryLength: 0,
};

describe('TelemetryRecorder', () => {
  it('does no pipeline work while telemetry is disabled', () => {
    const metrics = createMetricsSpy();
    const recorder = createTelemetryRecorder(
      metrics,
      createTelemetryPolicy('no'),
    );

    recorder.recordModelCall(usage);
    recorder.registerSession(session);
    recorder.updateSession(session.id, { active: false });
    recorder.recordToolCall(session.id, 'search', true);
    recorder.unregisterSession(session.id);

    expect(metrics.recordModelCall).not.toHaveBeenCalled();
    expect(metrics.registerSession).not.toHaveBeenCalled();
    expect(metrics.updateSession).not.toHaveBeenCalled();
    expect(metrics.recordToolCall).not.toHaveBeenCalled();
    expect(metrics.unregisterSession).not.toHaveBeenCalled();
  });

  it('keeps identifiers out of basic and enables detailed work at advanced', () => {
    const metrics = createMetricsSpy();
    const policy = createTelemetryPolicy('basic');
    const recorder = createTelemetryRecorder(metrics, policy);

    recorder.recordModelCall(usage);
    recorder.registerSession(session);
    recorder.recordToolCall(session.id, 'search', true);
    expect(metrics.recordModelCall).toHaveBeenCalledOnce();
    expect(metrics.registerSession).not.toHaveBeenCalled();
    expect(metrics.recordToolCall).not.toHaveBeenCalled();

    policy.setLevel('advanced');
    recorder.registerSession(session);
    recorder.updateSession(session.id, { active: false });
    recorder.recordToolCall(session.id, 'search', true);
    expect(metrics.registerSession).toHaveBeenCalledOnce();
    expect(metrics.updateSession).toHaveBeenCalledOnce();
    expect(metrics.recordToolCall).toHaveBeenCalledOnce();
  });
});
