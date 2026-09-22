import { describe, expect, it } from 'vitest';

import {
  isAllowedTelemetryAttribute,
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
  });
});
