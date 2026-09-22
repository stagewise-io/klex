import { describe, expect, it } from 'vitest';

import {
  createTelemetryPolicy,
  isAllowedTelemetryAttribute,
  isAlwaysForbiddenTelemetryAttribute,
  isTelemetryContentAttribute,
} from './telemetry-policy';

describe('telemetry policy', () => {
  it('recognizes content-bearing field names at separator boundaries', () => {
    for (const name of [
      'gen_ai.prompt',
      'prompt',
      'gen_ai.input_messages',
      'gen_ai.Prompt',
      'GEN_AI.PROMPT',
    ]) {
      expect(isTelemetryContentAttribute(name)).toBe(true);
    }

    for (const name of [
      'gen_ai.systemic_metric',
      'gen_ai.tools_invoke',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
    ]) {
      expect(isTelemetryContentAttribute(name)).toBe(false);
    }
  });

  it('allows only approved aggregate telemetry attributes', () => {
    for (const name of [
      'gen_ai.usage.input_tokens',
      'gen_ai.response.finish_reason',
      'gen_ai.usage.reasoning_tokens',
      'gen_ai.usage.cache_read.input_tokens',
      'gen_ai.usage.cache_creation.input_tokens',
      'klex.error.type',
      'error.type',
    ]) {
      expect(isAllowedTelemetryAttribute(name)).toBe(true);
    }
    expect(isAllowedTelemetryAttribute('gen_ai.input.messages')).toBe(false);
    expect(isAllowedTelemetryAttribute('klex.session.id', 'advanced')).toBe(
      true,
    );
    expect(isAllowedTelemetryAttribute('klex.session.id', 'basic')).toBe(false);
  });

  it('exposes immutable, level-specific policy snapshots', () => {
    const policy = createTelemetryPolicy('no');
    expect(policy.getSnapshot()).toMatchObject({
      level: 'no',
      telemetryWorkAllowed: false,
      traceMode: 'none',
      metricDetail: 'none',
    });

    policy.setLevel('advanced');
    expect(policy.getSnapshot()).toMatchObject({
      level: 'advanced',
      telemetryWorkAllowed: true,
      detailedMetricsEnabled: true,
      detailedTracesEnabled: true,
      contentAllowed: false,
    });

    policy.setLevel('debug');
    expect(policy.getSnapshot().contentAllowed).toBe(true);
    expect(Object.isFrozen(policy.getSnapshot())).toBe(true);
  });

  it('always rejects credential and host identity attribute names', () => {
    for (const name of [
      'authorization',
      'http.request.header.authorization',
      'api_key',
      'password',
      'host.name',
      'user.name',
    ]) {
      expect(isAlwaysForbiddenTelemetryAttribute(name)).toBe(true);
      expect(isAllowedTelemetryAttribute(name, 'debug')).toBe(false);
    }
  });
});
