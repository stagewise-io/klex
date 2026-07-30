import {
  CLIENT_CAPABILITIES_META_KEY,
  MISSING_REQUIRED_CLIENT_CAPABILITY_CODE,
  PUSH_NOTIFICATIONS_EXTENSION_ID,
} from './constants.js';
import type {
  MissingRequiredClientCapabilityData,
  PushNotificationsCapabilities,
  PushNotificationsClientCapabilitiesMeta,
} from './spec.types.js';

export type Metadata = Record<string, unknown>;

export const pushNotificationsCapabilities =
  (): PushNotificationsCapabilities => ({
    extensions: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} },
  });

export function withPushNotificationsCapability<
  T extends PushNotificationsCapabilities,
>(capabilities: T): T {
  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [PUSH_NOTIFICATIONS_EXTENSION_ID]: {},
    },
  };
}

export function withPushNotificationsClientCapability<T extends Metadata>(
  metadata: T,
): T & PushNotificationsClientCapabilitiesMeta {
  const current = metadata[CLIENT_CAPABILITIES_META_KEY];
  const capabilities =
    typeof current === 'object' && current !== null
      ? (current as PushNotificationsCapabilities)
      : {};
  return {
    ...metadata,
    [CLIENT_CAPABILITIES_META_KEY]:
      withPushNotificationsCapability(capabilities),
  };
}

export function hasPushNotificationsCapability(
  capabilities: PushNotificationsCapabilities | null | undefined,
): boolean {
  return (
    capabilities?.extensions !== undefined &&
    Object.hasOwn(capabilities.extensions, PUSH_NOTIFICATIONS_EXTENSION_ID)
  );
}

export function hasPerRequestPushNotificationsCapability(
  metadata: Metadata | null | undefined,
): boolean {
  const value = metadata?.[CLIENT_CAPABILITIES_META_KEY];
  return (
    typeof value === 'object' &&
    value !== null &&
    hasPushNotificationsCapability(value as PushNotificationsCapabilities)
  );
}

export function resolveServerPushNotificationsSupport(input: {
  discovery?: PushNotificationsCapabilities | null;
  initialization?: PushNotificationsCapabilities | null;
}): boolean {
  if (input.discovery !== undefined && input.discovery !== null) {
    return hasPushNotificationsCapability(input.discovery);
  }
  return hasPushNotificationsCapability(input.initialization);
}

export function missingPushNotificationsCapabilityError(): {
  code: typeof MISSING_REQUIRED_CLIENT_CAPABILITY_CODE;
  message: string;
  data: MissingRequiredClientCapabilityData;
} {
  return {
    code: MISSING_REQUIRED_CLIENT_CAPABILITY_CODE,
    message: 'Missing required client capability',
    data: { requiredCapabilities: pushNotificationsCapabilities() },
  };
}
