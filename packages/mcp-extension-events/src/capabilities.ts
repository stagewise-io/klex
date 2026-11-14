import {
  CLIENT_CAPABILITIES_META_KEY,
  EVENTS_EXTENSION_ID,
} from './constants.js';
import type { EventsCapabilities } from './spec.types.js';

export type Metadata = Record<string, unknown>;

export const eventsCapabilities = (): EventsCapabilities => ({
  extensions: { [EVENTS_EXTENSION_ID]: {} },
});

export function withEventsCapability<T extends EventsCapabilities>(
  capabilities: T,
): T {
  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [EVENTS_EXTENSION_ID]: {},
    },
  };
}

/** Adds the per-request client capability declaration to request `_meta`. */
export function withEventsClientCapability<T extends Metadata>(
  metadata: T,
): T & { [CLIENT_CAPABILITIES_META_KEY]: EventsCapabilities } {
  const current = metadata[CLIENT_CAPABILITIES_META_KEY];
  const capabilities =
    typeof current === 'object' && current !== null
      ? (current as EventsCapabilities)
      : {};
  return {
    ...metadata,
    [CLIENT_CAPABILITIES_META_KEY]: withEventsCapability(capabilities),
  };
}

export function hasEventsCapability(
  capabilities: EventsCapabilities | null | undefined,
): boolean {
  return (
    capabilities?.extensions !== undefined &&
    Object.hasOwn(capabilities.extensions, EVENTS_EXTENSION_ID)
  );
}

/** Whether the server declared `listChanged: true` in its extension settings. */
export function eventsListChangedSupported(
  capabilities: EventsCapabilities | null | undefined,
): boolean {
  return (
    capabilities?.extensions?.[EVENTS_EXTENSION_ID]?.['listChanged'] === true
  );
}

/** Discovery capabilities win over initialization capabilities when present. */
export function resolveServerEventsSupport(input: {
  discovery?: EventsCapabilities | null;
  initialization?: EventsCapabilities | null;
}): boolean {
  if (input.discovery !== undefined && input.discovery !== null) {
    return hasEventsCapability(input.discovery);
  }
  return hasEventsCapability(input.initialization);
}
