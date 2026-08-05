import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Mcp } from '@/mcp';
import type { MediaTransportConnector } from '@/media-transport';

import type { RealtimeSessionCoordinator } from './realtime';
import { createRealtimeMediaRuntime } from './runtime';

const logging = { child: vi.fn() } as unknown as RootLogger;
const mcp = {} as Mcp;

function harness(enabled: boolean) {
  const order: string[] = [];
  const connector = {
    connect: vi.fn(),
    close: vi.fn(async () => {
      order.push('connector-close');
    }),
  } as unknown as MediaTransportConnector;
  const coordinator = {
    start: vi.fn(async () => {
      order.push('coordinator-start');
    }),
    close: vi.fn(async () => {
      order.push('coordinator-close');
    }),
    getActiveSessionCount: vi.fn(() => 0),
  } satisfies RealtimeSessionCoordinator;
  const createConnector = vi.fn(() => connector);
  const createCoordinator = vi.fn(() => coordinator);
  const runtime = createRealtimeMediaRuntime({
    logging,
    mcp,
    provider: enabled
      ? {
          kind: 'openai-realtime',
          config: {
            modelId: 'gpt-realtime',
            apiKey: 'test-key',
            websocketUrl: 'wss://example.test/realtime',
          },
        }
      : undefined,
    createConnector,
    createCoordinator,
  });
  return {
    runtime,
    connector,
    coordinator,
    createConnector,
    createCoordinator,
    order,
  };
}

describe('createRealtimeMediaRuntime', () => {
  it('does not create realtime resources when disabled', async () => {
    const { runtime, createConnector, createCoordinator } = harness(false);
    await runtime.start();
    await runtime.close();
    expect(createConnector).not.toHaveBeenCalled();
    expect(createCoordinator).not.toHaveBeenCalled();
  });

  it('starts once and closes coordinator before native connector', async () => {
    const { runtime, createConnector, coordinator, connector, order } =
      harness(true);
    await Promise.all([runtime.start(), runtime.start()]);
    await Promise.all([runtime.close(), runtime.close()]);
    expect(createConnector).toHaveBeenCalledOnce();
    expect(coordinator.start).toHaveBeenCalledOnce();
    expect(coordinator.close).toHaveBeenCalledOnce();
    expect(connector.close).toHaveBeenCalledOnce();
    expect(order).toEqual([
      'coordinator-start',
      'coordinator-close',
      'connector-close',
    ]);
  });

  it('closes the connector when coordinator startup fails', async () => {
    const { runtime, coordinator, connector } = harness(true);
    vi.mocked(coordinator.start).mockRejectedValueOnce(
      new Error('start failed'),
    );
    await expect(runtime.start()).rejects.toThrow('start failed');
    expect(connector.close).toHaveBeenCalledOnce();
    await runtime.close();
    expect(connector.close).toHaveBeenCalledOnce();
  });
});
