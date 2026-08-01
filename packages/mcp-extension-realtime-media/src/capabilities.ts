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

export const realtimeMediaExtensionCapability =
  (): RealtimeMediaExtensionCapability => ({
    transports: ['livekit-room'],
    media: ['audio'],
  });

export const realtimeMediaCapabilities = (): RealtimeMediaCapabilities => ({
  extensions: {
    [REALTIME_MEDIA_EXTENSION_ID]: realtimeMediaExtensionCapability(),
  },
});

export function withRealtimeMediaCapability<
  T extends RealtimeMediaCapabilities,
>(capabilities: T): T {
  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [REALTIME_MEDIA_EXTENSION_ID]: realtimeMediaExtensionCapability(),
    },
  };
}

export function withRealtimeMediaClientCapability<T extends Metadata>(
  metadata: T,
): T & RealtimeMediaClientCapabilitiesMeta {
  const current = metadata[CLIENT_CAPABILITIES_META_KEY];
  const capabilities =
    typeof current === 'object' && current !== null
      ? (current as RealtimeMediaCapabilities)
      : {};
  return {
    ...metadata,
    [CLIENT_CAPABILITIES_META_KEY]: withRealtimeMediaCapability(capabilities),
  };
}

export function hasRealtimeMediaCapability(
  capabilities: RealtimeMediaCapabilities | null | undefined,
): boolean {
  const capability = capabilities?.extensions?.[REALTIME_MEDIA_EXTENSION_ID];
  if (typeof capability !== 'object' || capability === null) return false;
  const value = capability as Partial<RealtimeMediaExtensionCapability>;
  return (
    value.transports?.includes('livekit-room') === true &&
    value.media?.includes('audio') === true
  );
}

export function hasPerRequestRealtimeMediaCapability(
  metadata: Metadata | null | undefined,
): boolean {
  const value = metadata?.[CLIENT_CAPABILITIES_META_KEY];
  return (
    typeof value === 'object' &&
    value !== null &&
    hasRealtimeMediaCapability(value as RealtimeMediaCapabilities)
  );
}

export function resolveServerRealtimeMediaSupport(input: {
  discovery?: RealtimeMediaCapabilities | null;
  initialization?: RealtimeMediaCapabilities | null;
}): boolean {
  if (input.discovery !== undefined && input.discovery !== null) {
    return hasRealtimeMediaCapability(input.discovery);
  }
  return hasRealtimeMediaCapability(input.initialization);
}

export function missingRealtimeMediaCapabilityError(): {
  code: typeof MISSING_REQUIRED_CLIENT_CAPABILITY_CODE;
  message: string;
  data: MissingRequiredClientCapabilityData;
} {
  return {
    code: MISSING_REQUIRED_CLIENT_CAPABILITY_CODE,
    message: 'Missing required client capability',
    data: { requiredCapabilities: realtimeMediaCapabilities() },
  };
}
