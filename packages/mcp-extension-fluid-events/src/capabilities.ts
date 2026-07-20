import {
  CLIENT_CAPABILITIES_META_KEY,
  FLUID_EVENTS_EXTENSION_ID,
  MISSING_REQUIRED_CLIENT_CAPABILITY_CODE,
} from './constants.js';
import type {
  FluidEventsCapabilities,
  FluidEventsClientCapabilitiesMeta,
  MissingRequiredClientCapabilityData,
} from './spec.types.js';

export type Metadata = Record<string, unknown>;

export const fluidEventsCapabilities = (): FluidEventsCapabilities => ({
  extensions: { [FLUID_EVENTS_EXTENSION_ID]: {} },
});

export function withFluidEventsCapability<T extends FluidEventsCapabilities>(
  capabilities: T,
): T {
  return {
    ...capabilities,
    extensions: {
      ...capabilities.extensions,
      [FLUID_EVENTS_EXTENSION_ID]: {},
    },
  };
}

export function withFluidEventsClientCapability<T extends Metadata>(
  metadata: T,
): T & FluidEventsClientCapabilitiesMeta {
  const current = metadata[CLIENT_CAPABILITIES_META_KEY];
  const capabilities =
    typeof current === 'object' && current !== null
      ? (current as FluidEventsCapabilities)
      : {};
  return {
    ...metadata,
    [CLIENT_CAPABILITIES_META_KEY]: withFluidEventsCapability(capabilities),
  };
}

export function hasFluidEventsCapability(
  capabilities: FluidEventsCapabilities | null | undefined,
): boolean {
  return (
    capabilities?.extensions !== undefined &&
    Object.hasOwn(capabilities.extensions, FLUID_EVENTS_EXTENSION_ID)
  );
}

export function hasPerRequestFluidEventsCapability(
  metadata: Metadata | null | undefined,
): boolean {
  const value = metadata?.[CLIENT_CAPABILITIES_META_KEY];
  return (
    typeof value === 'object' &&
    value !== null &&
    hasFluidEventsCapability(value as FluidEventsCapabilities)
  );
}

export function resolveServerFluidEventsSupport(input: {
  discovery?: FluidEventsCapabilities | null;
  initialization?: FluidEventsCapabilities | null;
}): boolean {
  if (input.discovery !== undefined && input.discovery !== null) {
    return hasFluidEventsCapability(input.discovery);
  }
  return hasFluidEventsCapability(input.initialization);
}

export function missingFluidEventsCapabilityError(): {
  code: typeof MISSING_REQUIRED_CLIENT_CAPABILITY_CODE;
  message: string;
  data: MissingRequiredClientCapabilityData;
} {
  return {
    code: MISSING_REQUIRED_CLIENT_CAPABILITY_CODE,
    message: 'Missing required client capability',
    data: { requiredCapabilities: fluidEventsCapabilities() },
  };
}
