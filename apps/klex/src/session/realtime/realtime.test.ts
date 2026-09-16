import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';
import type { LiveKitRoomTransportDescriptor } from '@stagewise/mcp-extension-realtime-media';

import type { Mcp } from '@/mcp';
import type { MediaTransportConnector } from '@/media-transport';
import type { ConversationHost } from '@/session/interaction';

import {
  createProductionMediaTransportConnector,
  createRealtime,
  PRODUCTION_REALTIME_MEDIA_CAPABILITY,
} from './realtime';
import type { RealtimeSessionCoordinator } from './session-coordinator';

const logging = { child: vi.fn() } as unknown as RootLogger;
const mcp = {} as Mcp;
const conversationHost: ConversationHost = {
  acquireInteractionLease: vi.fn(),
};

function harness() {
  const order: string[] = [];
  const connector = {
    connect: vi.fn(),
    close: vi.fn(async () => {
      order.push('connector-close');
    }),
  } as unknown as MediaTransportConnector<LiveKitRoomTransportDescriptor>;
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
      model: {
        modelId: 'gpt-realtime',
        contextSize: 32_000,
        inputCapabilities: {},
      },
      config: {
        modelId: 'gpt-realtime',
        apiKey: 'test-key',
        websocketUrl: 'wss://example.test/realtime',
      },
    },
    ownedConnector: connector,
    conversationHost,
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
  it('composes the production LiveKit connector and capability', async () => {
    expect(PRODUCTION_REALTIME_MEDIA_CAPABILITY).toEqual({
      transports: ['livekit-room'],
      media: ['audio'],
    });
    const connector = createProductionMediaTransportConnector();
    await connector.close();
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
        model: {
          modelId: 'gpt-realtime',
          contextSize: 32_000,
          inputCapabilities: {},
        },
        config: {
          modelId: 'gpt-realtime',
          apiKey: 'test-key',
          websocketUrl: 'wss://example.test/realtime',
        },
      },
      ownedConnector: connector,
      conversationHost,
      createCoordinator: () => coordinator,
    });
    await realtime.start();
    await Promise.all([realtime.close(), realtime.close()]);
    expect(connector.close).toHaveBeenCalledOnce();
  });

  it('selects the Gemini Live factory for a gemini-live provider', async () => {
    vi.mocked(logging.child).mockClear();
    const { connector, coordinator } = harness();
    const createCoordinator = vi.fn((..._args: unknown[]) => coordinator);
    const realtime = createRealtime({
      logging,
      mcp,
      provider: {
        kind: 'gemini-live',
        model: {
          modelId: 'gemini-3.8-live',
          contextSize: 131_072,
          inputCapabilities: { audio: {} },
        },
        config: {
          modelId: 'gemini-3.8-live',
          apiKey: 'test-key',
          websocketUrl: 'wss://example.test/gemini-live',
        },
      },
      ownedConnector: connector,
      conversationHost,
      createCoordinator,
    });
    await realtime.start();
    expect(logging.child).toHaveBeenCalledWith({
      name: 'gemini-live',
      bindings: { module: 'gemini-live' },
    });
    expect(createCoordinator.mock.calls[0]?.[1]).toBeDefined();
    await realtime.close();
  });

  it('selects the GPT-Live factory for an openai-live provider', async () => {
    vi.mocked(logging.child).mockClear();
    const { connector, coordinator } = harness();
    const createCoordinator = vi.fn((..._args: unknown[]) => coordinator);
    const realtime = createRealtime({
      logging,
      mcp,
      provider: {
        kind: 'openai-live',
        model: {
          modelId: 'gpt-live-1',
          contextSize: 128_000,
          inputCapabilities: { audio: {} },
        },
        config: {
          modelId: 'gpt-live-1',
          apiKey: 'test-key',
          baseUrl: 'https://example.test/v1',
          responsesModelId: 'gpt-5.6-luna',
        },
      },
      ownedConnector: connector,
      conversationHost,
      createCoordinator,
    });
    await realtime.start();
    expect(logging.child).toHaveBeenCalledWith({
      name: 'gpt-live',
      bindings: { module: 'gpt-live' },
    });
    expect(createCoordinator.mock.calls[0]?.[1]).toBeDefined();
    await realtime.close();
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
