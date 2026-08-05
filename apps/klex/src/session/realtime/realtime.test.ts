import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Mcp } from '@/mcp';
import type { MediaTransportConnector } from '@/media-transport';

import {
  createProductionMediaTransportConnectorRegistry,
  createRealtime,
} from './realtime';
import type { RealtimeSessionCoordinator } from './session-coordinator';

const logging = { child: vi.fn() } as unknown as RootLogger;
const mcp = {} as Mcp;

function harness() {
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
  const createCoordinator = vi.fn(() => coordinator);
  const realtime = createRealtime({
    logging,
    mcp,
    provider: {
      kind: 'openai-realtime',
      config: {
        modelId: 'gpt-realtime',
        apiKey: 'test-key',
        websocketUrl: 'wss://example.test/realtime',
      },
    },
    ownedConnector: connector,
    createCoordinator,
  });
  return {
    realtime,
    connector,
    coordinator,
    createCoordinator,
    order,
  };
}

describe('createRealtime', () => {
  it('registers the production LiveKit profile', async () => {
    const registry = createProductionMediaTransportConnectorRegistry();
    expect(registry.profiles).toEqual(['livekit-room']);
    await registry.close();
  });

  it('starts once and closes coordinator before native connector', async () => {
    const { realtime, coordinator, connector, order } = harness();
    await Promise.all([realtime.start(), realtime.start()]);
    await Promise.all([realtime.close(), realtime.close()]);
    expect(coordinator.start).toHaveBeenCalledOnce();
    expect(coordinator.close).toHaveBeenCalledOnce();
    expect(connector.close).toHaveBeenCalledOnce();
    expect(order).toEqual([
      'coordinator-start',
      'coordinator-close',
      'connector-close',
    ]);
  });

  it('takes lifecycle ownership of an injected connector', async () => {
    const { connector, coordinator } = harness();
    const realtime = createRealtime({
      logging,
      mcp,
      provider: {
        kind: 'openai-realtime',
        config: {
          modelId: 'gpt-realtime',
          apiKey: 'test-key',
          websocketUrl: 'wss://example.test/realtime',
        },
      },
      ownedConnector: connector,
      createCoordinator: () => coordinator,
    });
    await realtime.start();
    await Promise.all([realtime.close(), realtime.close()]);
    expect(connector.close).toHaveBeenCalledOnce();
  });

  it('closes the connector when coordinator startup fails', async () => {
    const { realtime, coordinator, connector } = harness();
    vi.mocked(coordinator.start).mockRejectedValueOnce(
      new Error('start failed'),
    );
    await expect(realtime.start()).rejects.toThrow('start failed');
    expect(connector.close).toHaveBeenCalledOnce();
    await realtime.close();
    expect(connector.close).toHaveBeenCalledOnce();
  });
});
