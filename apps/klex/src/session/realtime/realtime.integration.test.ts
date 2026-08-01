import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config, ConfigListener, McpServerConfig } from '@/config';
import {
  type ConnectMcpServerOptions,
  createMcp,
  type McpConnection,
} from '@/mcp';
import {
  createDeterministicEchoProcessorFactory,
  createDeterministicMediaTransportConnector,
} from '@/media-transport/deterministic';

import { createRealtimeSessionCoordinator } from './realtime';

const logging = {
  child: () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

function configFor(servers: Record<string, McpServerConfig>): Config {
  let listener: ConfigListener | undefined;
  return {
    getMcpServers: () => servers,
    subscribe: (next: ConfigListener) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  } as unknown as Config;
}

describe('MCP to deterministic realtime session', () => {
  it('runs and cleans up a synthetic audio session through the MCP facade', async () => {
    let connectOptions: ConnectMcpServerOptions | undefined;
    const subscriptionClosed = Promise.withResolvers<void>();
    const accept = vi.fn(async () => ({
      transport: {
        profile: 'livekit-room' as const,
        url: 'wss://livekit.example.test',
        token: 'secret',
      },
    }));
    const end = vi.fn(async () => undefined);
    const close = vi.fn(async () => subscriptionClosed.resolve());
    const connection = {
      namespace: 'voice',
      tools: [],
      pushNotifications: {},
      supportsPushNotifications: false,
      supportsRealtimeMedia: true,
      realtimeMedia: {
        listen: vi.fn(
          async (
            _subscription: unknown,
            options: { request: { signal: AbortSignal } },
          ) => {
            options.request.signal.addEventListener(
              'abort',
              () => subscriptionClosed.resolve(),
              { once: true },
            );
            return { closed: subscriptionClosed.promise };
          },
        ),
        accept,
        reject: vi.fn(async () => undefined),
        end,
      },
      invoke: vi.fn(),
      close,
    } as unknown as McpConnection;
    const mcp = createMcp({
      logging,
      config: configFor({ voice: { url: 'https://voice.example/mcp' } }),
      connect: async (options) => {
        connectOptions = options;
        return connection;
      },
    });
    const connector = createDeterministicMediaTransportConnector();
    const processorFactory = createDeterministicEchoProcessorFactory();
    const coordinator = createRealtimeSessionCoordinator({
      logging,
      mcp,
      mediaTransportConnector: connector,
      processorFactory,
      now: () => Date.parse('2026-08-01T18:00:00.000Z'),
    });

    await coordinator.start();
    await mcp.start();
    await vi.waitFor(() => expect(connectOptions).toBeDefined());
    await vi.waitFor(() =>
      expect(connection.realtimeMedia?.listen).toHaveBeenCalledOnce(),
    );
    await connectOptions?.onRealtimeMediaNotification(connection, {
      jsonrpc: '2.0',
      method: 'io.stagewise/realtime-media/session-offered',
      params: {
        sessionId: 'session-1',
        expiresAt: '2026-08-01T19:00:00.000Z',
      },
    });

    const transport = await connector.nextTransport();
    const processor = await processorFactory.nextProcessor();
    const input = {
      encoding: 'pcm-s16le' as const,
      sampleRateHz: 16_000,
      channels: 1,
      sequence: 1,
      timestampUs: 20_000,
      data: Uint8Array.from([1, 2, 3, 4]),
    };
    await transport.inject(input);
    await expect(transport.receiveSent()).resolves.toEqual(input);

    await connectOptions?.onRealtimeMediaNotification(connection, {
      jsonrpc: '2.0',
      method: 'io.stagewise/realtime-media/session-ended',
      params: { sessionId: 'session-1', reason: 'remote-end' },
    });
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(accept).toHaveBeenCalledWith('session-1');
    expect(end).not.toHaveBeenCalled();
    expect(transport.closeCount).toBe(1);
    expect(processor.closeCount).toBe(1);

    await coordinator.close();
    await mcp.close();
    expect(close).toHaveBeenCalledOnce();
    await expect(subscriptionClosed.promise).resolves.toBeUndefined();
  });
});
