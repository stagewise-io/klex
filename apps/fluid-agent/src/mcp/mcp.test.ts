import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import { createInMemoryFluidEventInbox } from '@/fluid-event-inbox';

import { createMcp } from './mcp';

const logging = {
  child: () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

const config = {
  getMcpServers: () => ({}),
  subscribe: () => () => undefined,
} as unknown as Config;

describe('MCP Fluid Event subscriptions', () => {
  it('registers listeners and returns an idempotent unsubscribe function', async () => {
    const mcp = createMcp({
      logging,
      config,
      fluidEventInbox: createInMemoryFluidEventInbox(),
    });
    const listener = vi.fn();

    const unsubscribe = mcp.onFluidEvent(listener);
    unsubscribe();
    unsubscribe();

    await mcp.start();
    await mcp.close();
    expect(listener).not.toHaveBeenCalled();
  });
});
