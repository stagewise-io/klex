import { describe, expect, it } from 'vitest';

import {
  CLIENT_CAPABILITIES_META_KEY,
  hasPerRequestPushNotificationsCapability,
  missingPushNotificationsCapabilityError,
  PUSH_NOTIFICATIONS_EXTENSION_ID,
  resolveServerPushNotificationsSupport,
  withPushNotificationsCapability,
  withPushNotificationsClientCapability,
} from '../src/index.js';

describe('Push Notifications capabilities', () => {
  it('merges extension and metadata fields immutably', () => {
    const capabilities = { extensions: { other: { version: 1 } }, tools: {} };
    const advertised = withPushNotificationsCapability(capabilities);
    expect(advertised).toEqual({
      extensions: {
        other: { version: 1 },
        [PUSH_NOTIFICATIONS_EXTENSION_ID]: {},
      },
      tools: {},
    });
    expect(capabilities.extensions).toEqual({ other: { version: 1 } });

    const metadata = {
      trace: 'trace-id',
      [CLIENT_CAPABILITIES_META_KEY]: capabilities,
    };
    expect(withPushNotificationsClientCapability(metadata)).toMatchObject({
      trace: 'trace-id',
      [CLIENT_CAPABILITIES_META_KEY]: advertised,
    });
    expect(hasPerRequestPushNotificationsCapability(metadata)).toBe(false);
  });

  it('prefers discovery over initialization support', () => {
    const supported = withPushNotificationsCapability({});
    expect(
      resolveServerPushNotificationsSupport({
        discovery: {},
        initialization: supported,
      }),
    ).toBe(false);
    expect(
      resolveServerPushNotificationsSupport({ initialization: supported }),
    ).toBe(true);
  });

  it('builds the standard missing-capability error', () => {
    expect(missingPushNotificationsCapabilityError()).toEqual({
      code: -32003,
      message: 'Missing required client capability',
      data: {
        requiredCapabilities: {
          extensions: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} },
        },
      },
    });
  });
});
