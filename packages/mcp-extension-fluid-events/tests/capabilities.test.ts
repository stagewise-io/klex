import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  FLUID_EVENTS_EXTENSION_ID,
  hasPerRequestFluidEventsCapability,
  missingFluidEventsCapabilityError,
  resolveServerFluidEventsSupport,
  withFluidEventsCapability,
  withFluidEventsClientCapability,
} from '../src/index.js';

describe('Fluid Events capabilities', () => {
  it('merges extension and metadata fields immutably', () => {
    const capabilities = { extensions: { other: { version: 1 } }, tools: {} };
    const advertised = withFluidEventsCapability(capabilities);
    expect(advertised).toEqual({
      extensions: {
        other: { version: 1 },
        [FLUID_EVENTS_EXTENSION_ID]: {},
      },
      tools: {},
    });
    expect(capabilities.extensions).toEqual({ other: { version: 1 } });

    const metadata = {
      trace: 'trace-id',
      [CLIENT_CAPABILITIES_META_KEY]: capabilities,
    };
    expect(withFluidEventsClientCapability(metadata)).toMatchObject({
      trace: 'trace-id',
      [CLIENT_CAPABILITIES_META_KEY]: advertised,
    });
    expect(hasPerRequestFluidEventsCapability(metadata)).toBe(false);
  });

  it('prefers discovery over initialization support', () => {
    const supported = withFluidEventsCapability({});
    expect(
      resolveServerFluidEventsSupport({
        discovery: {},
        initialization: supported,
      }),
    ).toBe(false);
    expect(resolveServerFluidEventsSupport({ initialization: supported })).toBe(
      true,
    );
  });

  it('builds the standard missing-capability error', () => {
    expect(missingFluidEventsCapabilityError()).toEqual({
      code: -32003,
      message: 'Missing required client capability',
      data: {
        requiredCapabilities: {
          extensions: { [FLUID_EVENTS_EXTENSION_ID]: {} },
        },
      },
    });
  });
});
