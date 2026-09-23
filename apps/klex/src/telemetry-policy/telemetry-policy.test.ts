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

  it('exports no span attributes below advanced', () => {
    for (const level of ['no', 'basic'] as const) {
      expect(
        isAllowedTelemetryAttribute('gen_ai.usage.input_tokens', level, 1),
      ).toBe(false);
      expect(
        isAllowedTelemetryAttribute('gen_ai.request.model', level, 'm'),
      ).toBe(false);
    }
  });

  it('keeps GenAI metadata and cache usage at advanced but no content', () => {
    for (const [name, value] of [
      ['gen_ai.usage.input_tokens', 10],
      ['gen_ai.usage.cache_read.input_tokens', 4],
      ['gen_ai.usage.cache_creation.input_tokens', 2],
      ['klex.usage.cache_read_ratio', 0.4],
      ['klex.usage.reasoning_tokens', 3],
      ['gen_ai.request.model', 'claude'],
      ['gen_ai.provider.name', 'anthropic'],
      ['gen_ai.response.finish_reasons', ['stop']],
      ['klex.session.id', 'session-1'],
      ['klex.outcome', 'success'],
      ['error.type', 'TypeError'],
    ] as const) {
      expect(isAllowedTelemetryAttribute(name, 'advanced', value)).toBe(true);
    }
    for (const [name, value] of [
      ['gen_ai.input.messages', '[]'],
      ['gen_ai.output.messages', '[]'],
      ['gen_ai.system_instructions', 'be nice'],
      ['gen_ai.tool.call.arguments', '{}'],
      ['gen_ai.tool.call.result', '{}'],
      ['klex.abort.reason', 'Error: /Users/x'],
      ['error.message', 'boom'],
      ['host.name', 'laptop'],
    ] as const) {
      expect(isAllowedTelemetryAttribute(name, 'advanced', value)).toBe(false);
    }
  });

  it('keeps content at debug but never credentials', () => {
    expect(
      isAllowedTelemetryAttribute('gen_ai.input.messages', 'debug', '[]'),
    ).toBe(true);
    expect(isAllowedTelemetryAttribute('error.message', 'debug', 'boom')).toBe(
      true,
    );
    expect(
      isAllowedTelemetryAttribute(
        'http.request.header.authorization',
        'debug',
        'x',
      ),
    ).toBe(false);
    expect(isAllowedTelemetryAttribute('klex.api_key', 'debug', 'x')).toBe(
      false,
    );
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
    expect(policy.getSnapshot()).toMatchObject({
      contentAllowed: true,
      logThreshold: 'TRACE',
    });
    expect(Object.isFrozen(policy.getSnapshot())).toBe(true);
  });

  it('always rejects credential attribute names', () => {
    for (const name of [
      'authorization',
      'http.request.header.authorization',
      'api_key',
      'password',
    ]) {
      expect(isAlwaysForbiddenTelemetryAttribute(name)).toBe(true);
      expect(isAllowedTelemetryAttribute(name, 'debug', 'x')).toBe(false);
    }
  });

  it('exports host and user identity attributes only at debug', () => {
    for (const name of ['host.name', 'user.name']) {
      expect(isAlwaysForbiddenTelemetryAttribute(name)).toBe(false);
      expect(isAllowedTelemetryAttribute(name, 'advanced', 'x')).toBe(false);
      expect(isAllowedTelemetryAttribute(name, 'debug', 'x')).toBe(true);
    }
  });
});
