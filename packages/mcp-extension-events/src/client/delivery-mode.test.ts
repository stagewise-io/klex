import { describe, expect, it } from 'vitest';

import {
  NoCompatibleDeliveryModeError,
  selectDeliveryMode,
} from './delivery-mode.js';

describe('selectDeliveryMode', () => {
  it('prefers push over poll when both are available', () => {
    expect(
      selectDeliveryMode({ name: 'x', delivery: ['poll', 'push'] }, [
        'push',
        'poll',
      ]),
    ).toBe('push');
  });

  it('falls back to poll when push is unsupported by the client', () => {
    expect(
      selectDeliveryMode({ name: 'x', delivery: ['poll', 'push'] }, ['poll']),
    ).toBe('poll');
  });

  it('never picks webhook by default', () => {
    expect(() =>
      selectDeliveryMode({ name: 'x', delivery: ['webhook'] }, [
        'push',
        'poll',
        'webhook',
      ]),
    ).toThrow(NoCompatibleDeliveryModeError);
  });
});
