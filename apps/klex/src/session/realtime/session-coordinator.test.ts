import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';
import type {
  RealtimeMediaClientAcceptResult,
  RealtimeMediaNotification,
} from '@stagewise/mcp-extension-realtime-media';

import type {
  Mcp,
  McpRealtimeMediaAvailabilityListener,
  McpRealtimeMediaNotificationListener,
} from '@/mcp';
import type { AudioFrame } from '@/media-transport';
import { SessionInboxUrgency } from '@/session/inbox';
import type { InteractionUpdateEnvelope } from '@/session/interaction';

import { createRealtimeSessionCoordinator } from './session-coordinator';
import {
  createDeterministicConversationHost,
  createDeterministicEchoProcessorFactory,
  createDeterministicMediaTransportConnector,
  DETERMINISTIC_REALTIME_MODEL,
  type DeterministicConversationHost,
} from './test-support';

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
  accept?: () => Promise<RealtimeMediaClientAcceptResult>;
}) {
  const notificationListeners = new Set<McpRealtimeMediaNotificationListener>();
  const availabilityListeners = new Set<McpRealtimeMediaAvailabilityListener>();
  const acceptRealtimeMediaSession = vi.fn(
    options?.accept ??
      (async () => ({
        transport: { kind: 'livekit-room', descriptor },
      })),
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

function update(sequence: number): InteractionUpdateEnvelope {
  return {
    sequence,
    eventId: `update-${sequence}`,
    event: {
      eventId: `update-${sequence}`,
      sourceEnv: 'telegram',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'telegram',
        metadata: {},
        content: [{ type: 'text', text: 'Anna: are we live?' }],
      },
    },
    requestResponse: true,
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
  host?: DeterministicConversationHost;
  now?: () => number;
}) {
  const mcpHarness = options?.mcp ?? createMcpHarness();
  const connector = createDeterministicMediaTransportConnector();
  const processorFactory = createDeterministicEchoProcessorFactory();
  const host = options?.host ?? createDeterministicConversationHost();
  const coordinator = createRealtimeSessionCoordinator({
    logging,
    mcp: mcpHarness.mcp,
    mediaTransportConnector: connector,
    processorFactory,
    conversationHost: host,
    model: DETERMINISTIC_REALTIME_MODEL,
    now: options?.now ?? (() => Date.parse('2026-08-01T18:00:00.000Z')),
  });
  return { coordinator, connector, mcpHarness, processorFactory, host };
}

describe('realtime session coordinator', () => {
  it('ends an accepted session when its transport profile is unsupported', async () => {
    const mcpHarness = createMcpHarness({
      accept: async () => ({
        transport: {
          kind: 'unknown',
          descriptor: { ...descriptor, profile: 'unsupported' },
        },
      }),
    });
    const connector = createDeterministicMediaTransportConnector();
    const coordinator = createRealtimeSessionCoordinator({
      logging,
      mcp: mcpHarness.mcp,
      mediaTransportConnector: connector,
      processorFactory: createDeterministicEchoProcessorFactory(),
      conversationHost: createDeterministicConversationHost(),
      model: DETERMINISTIC_REALTIME_MODEL,
      now: () => Date.parse('2026-08-01T18:00:00.000Z'),
    });
    await coordinator.start();
    await mcpHarness.notify(offered());
    await vi.waitFor(() => {
      expect(mcpHarness.endRealtimeMediaSession).toHaveBeenCalledOnce();
      expect(coordinator.getActiveSessionCount()).toBe(0);
    });
    expect(connector.descriptors).toEqual([]);
    await coordinator.close();
  });

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
    const pendingAccept = deferred<RealtimeMediaClientAcceptResult>();
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
    pendingAccept.resolve({
      transport: { kind: 'livekit-room', descriptor },
    });
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    await coordinator.close();
  });

  it('does not connect when remote end races acceptance', async () => {
    const pendingAccept = deferred<RealtimeMediaClientAcceptResult>();
    const mcpHarness = createMcpHarness({
      accept: () => pendingAccept.promise,
    });
    const { coordinator, connector } = setup({ mcp: mcpHarness });
    await coordinator.start();
    await mcpHarness.notify(offered());
    await mcpHarness.notify(ended());
    pendingAccept.resolve({
      transport: { kind: 'livekit-room', descriptor },
    });

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

  it('rejects the offer when no interaction lease is available', async () => {
    const host = createDeterministicConversationHost();
    host.rejectAcquisitions(new Error('chat generation in progress'));
    const { coordinator, connector, mcpHarness } = setup({ host });
    await coordinator.start();
    await mcpHarness.notify(offered());

    await vi.waitFor(() =>
      expect(mcpHarness.rejectRealtimeMediaSession).toHaveBeenCalledWith(
        'voice',
        'session-1',
      ),
    );
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(mcpHarness.acceptRealtimeMediaSession).not.toHaveBeenCalled();
    expect(connector.descriptors).toEqual([]);
    expect(host.requests).toEqual([
      expect.objectContaining({
        mode: 'realtime',
        namespace: 'voice',
        externalSessionId: 'session-1',
        model: DETERMINISTIC_REALTIME_MODEL,
      }),
    ]);
    await coordinator.close();
  });

  it('models acquisition aborts in the deterministic host', async () => {
    const host = createDeterministicConversationHost();
    const controller = new AbortController();
    controller.abort(new Error('offer withdrawn'));

    await expect(
      host.acquireInteractionLease({
        mode: 'realtime',
        externalSessionId: 'session-1',
        namespace: 'voice',
        signal: controller.signal,
        model: DETERMINISTIC_REALTIME_MODEL,
      }),
    ).rejects.toThrow('offer withdrawn');
  });

  it('models primary-session revocation without releasing the lease', async () => {
    const { coordinator, mcpHarness, host } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();

    host.revokeLeases('primary-session-closed');

    await expect(lease.closed).resolves.toEqual({
      type: 'revoked',
      reason: 'primary-session-closed',
    });
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(lease.releaseCount).toBe(0);
    await coordinator.close();
  });

  it('commits the session lifecycle and releases the lease exactly once', async () => {
    const { coordinator, mcpHarness, host } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();

    await vi.waitFor(() =>
      expect(lease.commits.map((commit) => commit.type)).toEqual([
        'session-started',
      ]),
    );
    expect(lease.contextCommits).toBe(1);

    await mcpHarness.notify(ended());
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(lease.commits.map((commit) => commit.type)).toEqual([
      'session-started',
      'session-ended',
    ]);
    expect(lease.releaseCount).toBe(1);
    expect(lease.contextRollbacks).toBe(0);
    expect(host.requests[0]?.signal.aborted).toBe(false);

    await coordinator.close();
    expect(lease.releaseCount).toBe(1);
  });

  it('forwards inbox updates to the model and acknowledges them', async () => {
    const { coordinator, mcpHarness, processorFactory, host } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();
    const processor = await processorFactory.nextProcessor();

    expect(lease.publish(update(4))).toBe(true);
    await vi.waitFor(() => {
      expect(processor.receivedUpdates.map((entry) => entry.eventId)).toEqual([
        'update-4',
      ]);
      expect(lease.acknowledged).toEqual([4]);
    });

    await mcpHarness.notify(ended());
    await coordinator.close();
  });

  it('runs model tool calls through the lease and returns the result', async () => {
    const { coordinator, mcpHarness, processorFactory, host } = setup();
    host.setToolHandler((request) => ({
      executionId: request.executionId,
      status: 'success',
      output: { echoed: request.name },
    }));
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();
    const processor = await processorFactory.nextProcessor();

    await processor.emit({
      type: 'tool-call',
      eventId: 'call-1',
      request: {
        executionId: 'exec-1',
        name: 'send_message',
        input: { text: 'hi' },
      },
    });

    await vi.waitFor(() => {
      expect(lease.toolRequests.map((request) => request.executionId)).toEqual([
        'exec-1',
      ]);
      expect(processor.receivedToolResults).toEqual([
        {
          executionId: 'exec-1',
          status: 'success',
          output: { echoed: 'send_message' },
        },
      ]);
    });
    expect(lease.commits.map((commit) => commit.type)).toEqual([
      'session-started',
      'tool-call',
      'tool-result',
    ]);

    await mcpHarness.notify(ended());
    await coordinator.close();
  });

  it('commits transcripts emitted by the model session', async () => {
    const { coordinator, mcpHarness, processorFactory, host } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();
    const processor = await processorFactory.nextProcessor();

    await processor.emit({
      type: 'user-transcript',
      eventId: 'user-1',
      text: 'Are we live?',
    });
    await processor.emit({
      type: 'assistant-transcript',
      eventId: 'assistant-1',
      text: 'We are.',
      interrupted: true,
    });

    await vi.waitFor(() =>
      expect(lease.commits).toEqual([
        expect.objectContaining({ type: 'session-started' }),
        expect.objectContaining({
          type: 'user-transcript',
          eventId: 'user-1',
          text: 'Are we live?',
        }),
        expect.objectContaining({
          type: 'assistant-transcript',
          eventId: 'assistant-1',
          text: 'We are.',
          interrupted: true,
        }),
      ]),
    );

    await mcpHarness.notify(ended());
    await coordinator.close();
  });

  it('ends the media session when the lease is revoked', async () => {
    const { coordinator, mcpHarness, processorFactory, connector, host } =
      setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();
    const transport = await connector.nextTransport();
    const processor = await processorFactory.nextProcessor();

    lease.revoke('primary-session-terminated');

    await vi.waitFor(() =>
      expect(mcpHarness.endRealtimeMediaSession).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(transport.closeCount).toBe(1);
    expect(processor.closeCount).toBe(1);
    await coordinator.close();
  });

  it('releases the lease on setup failure before context preparation', async () => {
    const mcpHarness = createMcpHarness({
      accept: async () => ({
        transport: {
          kind: 'unknown',
          descriptor: { ...descriptor, profile: 'unsupported' },
        },
      }),
    });
    const { coordinator, host } = setup({ mcp: mcpHarness });
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();

    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(lease.releaseCount).toBe(1);
    await expect(lease.closed).resolves.toEqual({
      type: 'released',
      reason: 'realtime-session-ended',
    });
    await coordinator.close();
  });

  it('acquires a fresh lease for a session offered after the previous one ended', async () => {
    const { coordinator, mcpHarness, host } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const first = await host.nextLease();
    await mcpHarness.notify(ended());
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));

    await mcpHarness.notify(offered('session-2'));
    const second = await host.nextLease();
    expect(second.id).not.toBe(first.id);
    await vi.waitFor(() => expect(second.commits).toHaveLength(1));

    await coordinator.close();
    expect(first.releaseCount).toBe(1);
    expect(second.releaseCount).toBe(1);
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
