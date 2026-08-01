import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';
import type { RealtimeMediaNotification } from '@stagewise/mcp-extension-realtime-media';

import type {
  Mcp,
  McpRealtimeMediaAvailabilityListener,
  McpRealtimeMediaNotificationListener,
} from '@/mcp';
import type { AudioFrame } from '@/media-transport';
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

const descriptor = {
  profile: 'livekit-room' as const,
  url: 'wss://livekit.example.test',
  token: 'secret',
};

function frame(sequence: number): AudioFrame {
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 16_000,
    channels: 1,
    sequence,
    timestampUs: sequence * 20_000,
    data: Uint8Array.from([sequence, 0]),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createMcpHarness(options?: {
  accept?: () => Promise<{ transport: typeof descriptor }>;
}) {
  const notificationListeners = new Set<McpRealtimeMediaNotificationListener>();
  const availabilityListeners = new Set<McpRealtimeMediaAvailabilityListener>();
  const acceptRealtimeMediaSession = vi.fn(
    options?.accept ?? (async () => ({ transport: descriptor })),
  );
  const rejectRealtimeMediaSession = vi.fn(async () => undefined);
  const endRealtimeMediaSession = vi.fn(async () => undefined);
  const mcp = {
    onRealtimeMediaNotification(
      listener: McpRealtimeMediaNotificationListener,
    ) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onRealtimeMediaAvailability(
      listener: McpRealtimeMediaAvailabilityListener,
    ) {
      availabilityListeners.add(listener);
      return () => availabilityListeners.delete(listener);
    },
    acceptRealtimeMediaSession,
    rejectRealtimeMediaSession,
    endRealtimeMediaSession,
  } as unknown as Mcp;
  return {
    mcp,
    acceptRealtimeMediaSession,
    rejectRealtimeMediaSession,
    endRealtimeMediaSession,
    async notify(notification: RealtimeMediaNotification) {
      await Promise.all(
        [...notificationListeners].map((listener) =>
          listener({ namespace: 'voice', notification }),
        ),
      );
    },
    async setAvailable(available: boolean) {
      await Promise.all(
        [...availabilityListeners].map((listener) =>
          listener({ namespace: 'voice', available }),
        ),
      );
    },
  };
}

function offered(
  sessionId = 'session-1',
  expiresAt = '2026-08-01T19:00:00.000Z',
): RealtimeMediaNotification {
  return {
    jsonrpc: '2.0',
    method: 'io.stagewise/realtime-media/session-offered',
    params: { sessionId, expiresAt },
  };
}

function ended(sessionId = 'session-1'): RealtimeMediaNotification {
  return {
    jsonrpc: '2.0',
    method: 'io.stagewise/realtime-media/session-ended',
    params: { sessionId, reason: 'remote-end' },
  };
}

function setup(options?: {
  mcp?: ReturnType<typeof createMcpHarness>;
  now?: () => number;
}) {
  const mcpHarness = options?.mcp ?? createMcpHarness();
  const connector = createDeterministicMediaTransportConnector();
  const processorFactory = createDeterministicEchoProcessorFactory();
  const coordinator = createRealtimeSessionCoordinator({
    logging,
    mcp: mcpHarness.mcp,
    mediaTransportConnector: connector,
    processorFactory,
    now: options?.now ?? (() => Date.parse('2026-08-01T18:00:00.000Z')),
  });
  return { coordinator, connector, mcpHarness, processorFactory };
}

describe('realtime session coordinator', () => {
  it('accepts an offer, echoes ordered frames, and handles remote end once', async () => {
    const { coordinator, connector, mcpHarness, processorFactory } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const transport = await connector.nextTransport();
    const processor = await processorFactory.nextProcessor();

    await transport.inject(frame(1));
    await transport.inject(frame(2));
    await expect(transport.receiveSent()).resolves.toEqual(frame(1));
    await expect(transport.receiveSent()).resolves.toEqual(frame(2));

    await mcpHarness.notify(ended());
    await mcpHarness.notify(ended());
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(mcpHarness.acceptRealtimeMediaSession).toHaveBeenCalledOnce();
    expect(mcpHarness.endRealtimeMediaSession).not.toHaveBeenCalled();
    expect(transport.closeCount).toBe(1);
    expect(processor.closeCount).toBe(1);
    await coordinator.close();
  });

  it('rejects expired offers and ignores duplicate active offers', async () => {
    const pendingAccept = deferred<{ transport: typeof descriptor }>();
    const mcpHarness = createMcpHarness({
      accept: () => pendingAccept.promise,
    });
    const { coordinator } = setup({ mcp: mcpHarness });
    await coordinator.start();

    await mcpHarness.notify(offered('expired', '2026-08-01T17:00:00.000Z'));
    await vi.waitFor(() =>
      expect(mcpHarness.rejectRealtimeMediaSession).toHaveBeenCalledWith(
        'voice',
        'expired',
      ),
    );
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));

    await mcpHarness.notify(offered());
    await mcpHarness.notify(offered());
    expect(mcpHarness.acceptRealtimeMediaSession).toHaveBeenCalledTimes(1);
    await mcpHarness.notify(ended());
    pendingAccept.resolve({ transport: descriptor });
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    await coordinator.close();
  });

  it('does not connect when remote end races acceptance', async () => {
    const pendingAccept = deferred<{ transport: typeof descriptor }>();
    const mcpHarness = createMcpHarness({
      accept: () => pendingAccept.promise,
    });
    const { coordinator, connector } = setup({ mcp: mcpHarness });
    await coordinator.start();
    await mcpHarness.notify(offered());
    await mcpHarness.notify(ended());
    pendingAccept.resolve({ transport: descriptor });

    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(connector.descriptors).toEqual([]);
    expect(mcpHarness.endRealtimeMediaSession).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('ends the MCP session on media closure and transport failure', async () => {
    const first = setup();
    await first.coordinator.start();
    await first.mcpHarness.notify(offered());
    const closedTransport = await first.connector.nextTransport();
    closedTransport.remoteClose('participant-left');
    await vi.waitFor(() =>
      expect(first.mcpHarness.endRealtimeMediaSession).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(first.coordinator.getActiveSessionCount()).toBe(0),
    );
    await first.coordinator.close();

    const second = setup();
    await second.coordinator.start();
    await second.mcpHarness.notify(offered());
    const failedTransport = await second.connector.nextTransport();
    failedTransport.fail(new Error('network failed'));
    await vi.waitFor(() =>
      expect(second.mcpHarness.endRealtimeMediaSession).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(second.coordinator.getActiveSessionCount()).toBe(0),
    );
    expect(failedTransport.closeCount).toBe(1);
    await second.coordinator.close();
  });

  it('ends the MCP session on processor failure', async () => {
    const { coordinator, mcpHarness, processorFactory } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const processor = await processorFactory.nextProcessor();
    processor.fail(new Error('model failed'));

    await vi.waitFor(() =>
      expect(mcpHarness.endRealtimeMediaSession).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(processor.closeCount).toBe(1);
    await coordinator.close();
  });

  it('preserves outbound backpressure until sent frames are consumed', async () => {
    const { coordinator, connector, mcpHarness } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const transport = await connector.nextTransport();

    await transport.inject(frame(1));
    await transport.inject(frame(2));
    const thirdInput = transport.inject(frame(3));
    const settled = vi.fn();
    void thirdInput.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await expect(transport.receiveSent()).resolves.toEqual(frame(1));
    await expect(transport.receiveSent()).resolves.toEqual(frame(2));
    await expect(thirdInput).resolves.toBeUndefined();
    await expect(transport.receiveSent()).resolves.toEqual(frame(3));
    await mcpHarness.notify(ended());
    await coordinator.close();
  });

  it('cleans up without ending remotely on MCP disconnect', async () => {
    const { coordinator, connector, mcpHarness, processorFactory } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const transport = await connector.nextTransport();
    const processor = await processorFactory.nextProcessor();

    await mcpHarness.setAvailable(false);
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(mcpHarness.endRealtimeMediaSession).not.toHaveBeenCalled();
    expect(transport.closeCount).toBe(1);
    expect(processor.closeCount).toBe(1);
    await coordinator.close();
  });

  it('closes active sessions and itself idempotently', async () => {
    const { coordinator, connector, mcpHarness, processorFactory } = setup();
    await coordinator.start();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const transport = await connector.nextTransport();
    const processor = await processorFactory.nextProcessor();

    await coordinator.close();
    await coordinator.close();
    expect(mcpHarness.endRealtimeMediaSession).toHaveBeenCalledOnce();
    expect(transport.closeCount).toBe(1);
    expect(processor.closeCount).toBe(1);
    expect(coordinator.getActiveSessionCount()).toBe(0);
  });
});
