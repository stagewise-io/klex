import { describe, expect, it } from 'vitest';

import {
  isAllowedTelemetryAttribute,
  isTelemetryContentAttribute,
} from './telemetry-policy';

describe('telemetry policy', () => {
  it('recognizes content-bearing field names', () => {
    expect(isTelemetryContentAttribute('gen_ai.input.messages')).toBe(true);
    expect(isTelemetryContentAttribute('klex.usage.tokens')).toBe(false);
    expect(isTelemetryContentAttribute('gen_ai.usage.input_tokens')).toBe(
      false,
    );
    expect(isTelemetryContentAttribute('gen_ai.usage.output_tokens')).toBe(
      false,
    );
    expect(isAllowedTelemetryAttribute('gen_ai.usage.input_tokens')).toBe(true);
    expect(isAllowedTelemetryAttribute('gen_ai.input.messages')).toBe(false);
  });
});
