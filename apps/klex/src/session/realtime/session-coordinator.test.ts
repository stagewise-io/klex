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
import type {
  InteractionUpdateEnvelope,
  PreparedInferenceContextHandle,
} from '@/session/interaction';

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

  it('accepts an offer, drains final model events, and handles remote end once', async () => {
    const { coordinator, connector, mcpHarness, processorFactory, host } =
      setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const transport = await connector.nextTransport();
    const processor = await processorFactory.nextProcessor();
    const lease = await host.nextLease();

    await transport.inject(frame(1));
    await transport.inject(frame(2));
    await expect(transport.receiveSent()).resolves.toEqual(frame(1));
    await expect(transport.receiveSent()).resolves.toEqual(frame(2));
    processor.emitOnClose({
      type: 'approximate-transcript-group',
      eventId: 'final-group',
      speaker: 'assistant',
      text: 'final words',
      startMs: 10,
      endMs: 20,
    });

    await mcpHarness.notify(ended());
    await mcpHarness.notify(ended());
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(mcpHarness.acceptRealtimeMediaSession).toHaveBeenCalledOnce();
    expect(mcpHarness.endRealtimeMediaSession).not.toHaveBeenCalled();
    expect(transport.closeCount).toBe(1);
    expect(processor.closeCount).toBe(1);
    expect(processor.signalAbortedAtClose).toBe(false);
    expect(lease.commits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'approximate-transcript-group',
          eventId: 'final-group',
          text: 'final words',
        }),
      ]),
    );
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

  it('models default-session revocation without releasing the lease', async () => {
    const { coordinator, mcpHarness, host } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();

    host.revokeLeases('default-session-closed');

    await expect(lease.closed).resolves.toEqual({
      type: 'revoked',
      reason: 'default-session-closed',
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

  it('runs realtime tool calls concurrently', async () => {
    const { coordinator, mcpHarness, processorFactory, host } = setup();
    const first = deferred<{
      executionId: string;
      status: 'success';
      output: { call: string };
    }>();
    const second = deferred<{
      executionId: string;
      status: 'success';
      output: { call: string };
    }>();
    host.setToolHandler((request) =>
      request.executionId === 'exec-1' ? first.promise : second.promise,
    );
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();
    const processor = await processorFactory.nextProcessor();

    await processor.emit({
      type: 'tool-call',
      eventId: 'call-1',
      request: { executionId: 'exec-1', name: 'first', input: {} },
    });
    await processor.emit({
      type: 'tool-call',
      eventId: 'call-2',
      request: { executionId: 'exec-2', name: 'second', input: {} },
    });

    await vi.waitFor(() => expect(lease.toolRequests).toHaveLength(2));
    second.resolve({
      executionId: 'exec-2',
      status: 'success',
      output: { call: 'second' },
    });
    first.resolve({
      executionId: 'exec-1',
      status: 'success',
      output: { call: 'first' },
    });
    await vi.waitFor(() =>
      expect(processor.receivedToolResults).toHaveLength(2),
    );

    await mcpHarness.notify(ended());
    await coordinator.close();
  });

  it('aborts a provider-cancelled tool call without returning a result', async () => {
    const { coordinator, mcpHarness, processorFactory, host } = setup();
    let executionSignal: AbortSignal | undefined;
    host.setToolHandler((request, options) => {
      executionSignal = options?.signal;
      return new Promise((resolve) =>
        options?.signal?.addEventListener(
          'abort',
          () =>
            resolve({
              executionId: request.executionId,
              status: 'error',
              code: 'aborted',
              error: 'Tool execution was aborted.',
              retryable: true,
            }),
          { once: true },
        ),
      );
    });
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();
    const processor = await processorFactory.nextProcessor();

    await processor.emit({
      type: 'tool-call',
      eventId: 'call-cancelled',
      request: { executionId: 'exec-cancelled', name: 'slow', input: {} },
    });
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    await processor.emit({
      type: 'tool-call-cancelled',
      eventId: 'cancel-1',
      executionId: 'exec-cancelled',
    });
    await vi.waitFor(() => expect(executionSignal?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(lease.commits.map((commit) => commit.type)).toEqual([
        'session-started',
        'tool-call',
        'tool-result',
      ]),
    );

    expect(processor.receivedToolResults).toEqual([]);
    expect(lease.commits.at(-1)).toMatchObject({
      type: 'tool-result',
      result: { executionId: 'exec-cancelled', code: 'aborted' },
    });

    await mcpHarness.notify(ended());
    await coordinator.close();
  });

  it('returns invalid tool calls without committing fabricated tool activity', async () => {
    const { coordinator, mcpHarness, processorFactory, host } = setup();
    await coordinator.start();
    await mcpHarness.notify(offered());
    const lease = await host.nextLease();
    const processor = await processorFactory.nextProcessor();

    await processor.emit({
      type: 'invalid-tool-call',
      eventId: 'invalid-call-1',
      result: {
        executionId: 'exec-invalid',
        status: 'error',
        code: 'invalid-input',
        error: 'invalid JSON',
        retryable: false,
      },
    });

    await vi.waitFor(() =>
      expect(processor.receivedToolResults).toHaveLength(1),
    );
    expect(lease.commits.map((commit) => commit.type)).toEqual([
      'session-started',
    ]);
    expect(lease.toolRequests).toEqual([]);

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

    lease.revoke('default-session-terminated');

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

  it('rolls back context that finishes bootstrapping after teardown', async () => {
    vi.useFakeTimers();
    const pendingBootstrap = deferred<PreparedInferenceContextHandle>();
    const bootstrapStarted = deferred<void>();
    let preparedHandle: PreparedInferenceContextHandle | undefined;
    const host = createDeterministicConversationHost();
    const acquireLease = host.acquireInteractionLease.bind(host);
    vi.spyOn(host, 'acquireInteractionLease').mockImplementation(
      async (request) => {
        const lease = await acquireLease(request);
        preparedHandle = await lease.bootstrap();
        vi.spyOn(lease, 'bootstrap').mockImplementation(() => {
          bootstrapStarted.resolve(undefined);
          return pendingBootstrap.promise;
        });
        return lease;
      },
    );
    const { coordinator, mcpHarness } = setup({ host });
    try {
      await coordinator.start();
      await mcpHarness.notify(offered());
      const lease = await host.nextLease();
      await bootstrapStarted.promise;

      await mcpHarness.notify(ended());
      const closing = coordinator.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      expect(lease.releaseCount).toBe(1);
      expect(lease.contextRollbacks).toBe(0);

      if (!preparedHandle) throw new Error('Expected prepared context handle');
      pendingBootstrap.resolve(preparedHandle);
      await vi.waitFor(() => expect(lease.contextRollbacks).toBe(1));
    } finally {
      vi.useRealTimers();
      await coordinator.close();
    }
  });

  it('bounds teardown while accepted-session setup is stuck', async () => {
    vi.useFakeTimers();
    const pendingAccept = deferred<RealtimeMediaClientAcceptResult>();
    const mcpHarness = createMcpHarness({
      accept: () => pendingAccept.promise,
    });
    const { coordinator, host } = setup({ mcp: mcpHarness });
    try {
      await coordinator.start();
      await mcpHarness.notify(offered());
      const lease = await host.nextLease();
      await vi.waitFor(() =>
        expect(mcpHarness.acceptRealtimeMediaSession).toHaveBeenCalledOnce(),
      );

      await mcpHarness.notify(ended());
      const closing = coordinator.close();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(lease.releaseCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await closing;

      expect(lease.releaseCount).toBe(1);
      expect(coordinator.getActiveSessionCount()).toBe(0);
    } finally {
      pendingAccept.resolve({
        transport: { kind: 'livekit-room', descriptor },
      });
      await Promise.resolve();
      vi.useRealTimers();
    }
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
