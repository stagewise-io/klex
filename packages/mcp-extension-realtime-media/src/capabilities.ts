import {
  CLIENT_CAPABILITIES_META_KEY,
  MISSING_REQUIRED_CLIENT_CAPABILITY_CODE,
  REALTIME_MEDIA_EXTENSION_ID,
} from './constants.js';
import type {
  MissingRequiredClientCapabilityData,
  RealtimeMediaCapabilities,
  RealtimeMediaClientCapabilitiesMeta,
  RealtimeMediaExtensionCapability,
} from './spec.types.js';

export type Metadata = Record<string, unknown>;

export const DEFAULT_REALTIME_MEDIA_CAPABILITY = {
  transports: ['livekit-room'],
  media: ['audio'],
} satisfies RealtimeMediaExtensionCapability;

export const realtimeMediaExtensionCapability = (
  transports: readonly string[] = DEFAULT_REALTIME_MEDIA_CAPABILITY.transports,
): RealtimeMediaExtensionCapability => ({
  transports: [...transports],
  media: ['audio'],
});

export const realtimeMediaCapabilities = (
  capability: RealtimeMediaExtensionCapability = DEFAULT_REALTIME_MEDIA_CAPABILITY,
): RealtimeMediaCapabilities => ({
  extensions: {
    [REALTIME_MEDIA_EXTENSION_ID]: capability,
  },
});

export function withRealtimeMediaCapability<
  T extends RealtimeMediaCapabilities,
>(
  capabilities: T,
  capability: RealtimeMediaExtensionCapability = DEFAULT_REALTIME_MEDIA_CAPABILITY,
): T {
  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [REALTIME_MEDIA_EXTENSION_ID]: capability,
    },
  };
}

export function withRealtimeMediaClientCapability<T extends Metadata>(
  metadata: T,
  capability: RealtimeMediaExtensionCapability = DEFAULT_REALTIME_MEDIA_CAPABILITY,
): T & RealtimeMediaClientCapabilitiesMeta {
  const current = metadata[CLIENT_CAPABILITIES_META_KEY];
  const capabilities =
    typeof current === 'object' && current !== null
      ? (current as RealtimeMediaCapabilities)
      : {};
  return {
    ...metadata,
    [CLIENT_CAPABILITIES_META_KEY]: withRealtimeMediaCapability(
      capabilities,
      capability,
    ),
  };
}

export function hasRealtimeMediaCapability(
  capabilities: RealtimeMediaCapabilities | null | undefined,
  localCapability: RealtimeMediaExtensionCapability = DEFAULT_REALTIME_MEDIA_CAPABILITY,
): boolean {
  const capability = capabilities?.extensions?.[REALTIME_MEDIA_EXTENSION_ID];
  if (typeof capability !== 'object' || capability === null) return false;
  const value = capability as Partial<RealtimeMediaExtensionCapability>;
  return (
    Array.isArray(value.transports) &&
    value.transports.some(
      (profile) =>
        typeof profile === 'string' &&
        localCapability.transports.includes(profile),
    ) &&
    value.media?.includes('audio') === true &&
    localCapability.media.includes('audio')
  );
}

export function hasPerRequestRealtimeMediaCapability(
  metadata: Metadata | null | undefined,
  localCapability: RealtimeMediaExtensionCapability = DEFAULT_REALTIME_MEDIA_CAPABILITY,
): boolean {
  const value = metadata?.[CLIENT_CAPABILITIES_META_KEY];
  return (
    typeof value === 'object' &&
    value !== null &&
    hasRealtimeMediaCapability(
      value as RealtimeMediaCapabilities,
      localCapability,
    )
  );
}

export function resolveServerRealtimeMediaSupport(input: {
  discovery?: RealtimeMediaCapabilities | null;
  initialization?: RealtimeMediaCapabilities | null;
  localCapability?: RealtimeMediaExtensionCapability;
}): boolean {
  const capability = input.localCapability ?? DEFAULT_REALTIME_MEDIA_CAPABILITY;
  if (input.discovery !== undefined && input.discovery !== null) {
    return hasRealtimeMediaCapability(input.discovery, capability);
  }
  return hasRealtimeMediaCapability(input.initialization, capability);
}

export function missingRealtimeMediaCapabilityError(
  capability: RealtimeMediaExtensionCapability = DEFAULT_REALTIME_MEDIA_CAPABILITY,
): {
  code: typeof MISSING_REQUIRED_CLIENT_CAPABILITY_CODE;
  message: string;
  data: MissingRequiredClientCapabilityData;
} {
  return {
    code: MISSING_REQUIRED_CLIENT_CAPABILITY_CODE,
    message: 'Missing required client capability',
    data: { requiredCapabilities: realtimeMediaCapabilities(capability) },
  };
}
