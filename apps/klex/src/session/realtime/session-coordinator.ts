import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import type {
  LiveKitRoomTransportDescriptor,
  RealtimeMediaNotification,
  RealtimeMediaSessionOfferedNotificationParams,
} from '@stagewise/mcp-extension-realtime-media';

import type {
  Mcp,
  McpRealtimeMediaAvailability,
  McpRealtimeMediaNotification,
} from '@/mcp';
import type {
  AudioFrame,
  MediaTransport,
  MediaTransportConnector,
} from '@/media-transport';
import type {
  ConversationHost,
  InteractionLease,
  InteractionModelMetadata,
  InteractionUpdateEnvelope,
  PreparedInferenceContextHandle,
} from '@/session/interaction';
import {
  registerActivityStateProviders,
  setRealtimeSessionCount,
} from '@/telemetry-metrics';

import type {
  RealtimeModelEvent,
  RealtimeModelSession,
  RealtimeModelSessionFactory,
} from './model-session';

export interface RealtimeSessionCoordinator {
  start(): Promise<void>;
  close(): Promise<void>;
  getActiveSessionCount(): number;
}

export interface RealtimeSessionCoordinatorDependencies {
  logging: RootLogger;
  mcp: Mcp;
  mediaTransportConnector: MediaTransportConnector<LiveKitRoomTransportDescriptor>;
  processorFactory: RealtimeModelSessionFactory;
  /** Owner of canonical history, tools, and the generation lane. */
  conversationHost: ConversationHost;
  /** Resolves provider factory and model metadata as one per-call snapshot. */
  resolveCallConfiguration?: () => {
    model: InteractionModelMetadata;
    processorFactory: RealtimeModelSessionFactory;
  };
  /** Resolves non-secret model metadata for each new call. */
  resolveModel?: () => InteractionModelMetadata;
  /** @deprecated Static model compatibility for tests/callers. */
  model?: InteractionModelMetadata;
  now?: () => number;
}

const TEARDOWN_PHASE_TIMEOUT_MS = 5_000;

interface ActiveRealtimeSession {
  key: string;
  namespace: string;
  sessionId: string;
  controller: AbortController;
  acquisitionController: AbortController;
  accepted: boolean;
  endSent: boolean;
  transport?: MediaTransport;
  processor?: RealtimeModelSession;
  lease?: InteractionLease;
  contextHandle?: PreparedInferenceContextHandle;
  callConfiguration?: {
    model: InteractionModelMetadata;
    processorFactory: RealtimeModelSessionFactory;
  };
  contextSettled: boolean;
  setup?: Promise<void>;
  modelEventTask?: Promise<void>;
  tasks: Promise<void>[];
  finish?: Promise<void>;
}

class RealtimeSessionCoordinatorModule implements RealtimeSessionCoordinator {
  private readonly sessions = new Map<string, ActiveRealtimeSession>();
  private started = false;
  private notificationUnsubscribe: (() => void) | undefined;
  private availabilityUnsubscribe: (() => void) | undefined;
  private unregisterActivityProvider: (() => void) | undefined;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      mcp: Mcp;
      mediaTransportConnector: MediaTransportConnector<LiveKitRoomTransportDescriptor>;
      processorFactory: RealtimeModelSessionFactory;
      conversationHost: ConversationHost;
      resolveCallConfiguration: () => {
        model: InteractionModelMetadata;
        processorFactory: RealtimeModelSessionFactory;
      };
      now: () => number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.unregisterActivityProvider = registerActivityStateProviders({
        getRealtimeSessionCount: () => this.sessions.size,
      });
      this.notificationUnsubscribe = this.deps.mcp.onRealtimeMediaNotification(
        (event) => this.handleNotification(event),
      );
      this.availabilityUnsubscribe = this.deps.mcp.onRealtimeMediaAvailability(
        (event) => this.handleAvailability(event),
      );
      this.deps.logger.info('Realtime session coordinator started');
    } catch (error) {
      this.started = false;
      try {
        this.detachLifecycleResources();
      } catch {
        // Preserve the startup error after attempting every cleanup action.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.started = false;
    let cleanupError: unknown;
    try {
      this.detachLifecycleResources();
    } catch (error) {
      cleanupError = error;
    }
    if (this.sessions.size > 0) {
      await Promise.allSettled(
        [...this.sessions.values()].map((session) =>
          this.finishSession(session, { notifyRemote: session.accepted }),
        ),
      );
    }
    this.deps.logger.info('Realtime session coordinator stopped');
    if (cleanupError) throw cleanupError;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  private detachLifecycleResources(): void {
    let cleanupError: unknown;
    const cleanup = (action: (() => void) | undefined): void => {
      if (!action) return;
      try {
        action();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    const notificationUnsubscribe = this.notificationUnsubscribe;
    const availabilityUnsubscribe = this.availabilityUnsubscribe;
    const unregisterActivityProvider = this.unregisterActivityProvider;
    this.notificationUnsubscribe = undefined;
    this.availabilityUnsubscribe = undefined;
    this.unregisterActivityProvider = undefined;
    cleanup(notificationUnsubscribe);
    cleanup(availabilityUnsubscribe);
    cleanup(unregisterActivityProvider);
    if (cleanupError) throw cleanupError;
  }

  private async handleNotification(
    event: McpRealtimeMediaNotification,
  ): Promise<void> {
    if (!this.started) return;
    const notification: RealtimeMediaNotification = event.notification;
    if (notification.method === 'io.stagewise/realtime-media/session-offered') {
      this.handleOffer(event.namespace, notification.params);
      return;
    }
    const session = this.sessions.get(
      sessionKey(event.namespace, notification.params.sessionId),
    );
    if (!session) return;
    void this.finishSession(session, { notifyRemote: false });
  }

  private handleOffer(
    namespace: string,
    offer: RealtimeMediaSessionOfferedNotificationParams,
  ): void {
    const key = sessionKey(namespace, offer.sessionId);
    if (this.sessions.has(key)) return;
    const session: ActiveRealtimeSession = {
      key,
      namespace,
      sessionId: offer.sessionId,
      controller: new AbortController(),
      acquisitionController: new AbortController(),
      accepted: false,
      endSent: false,
      contextSettled: false,
      tasks: [],
    };
    this.sessions.set(key, session);
    setRealtimeSessionCount(this.sessions.size);
    session.setup = this.activateSession(session, offer).catch(
      (error: unknown) => {
        if (!session.controller.signal.aborted) {
          this.deps.logger.warn(
            { error, namespace, sessionId: offer.sessionId },
            'Realtime session setup failed',
          );
        }
        void this.finishSession(session, {
          notifyRemote: session.accepted,
        });
      },
    );
  }

  private async activateSession(
    session: ActiveRealtimeSession,
    offer: RealtimeMediaSessionOfferedNotificationParams,
  ): Promise<void> {
    if (Date.parse(offer.expiresAt) <= this.deps.now()) {
      await this.deps.mcp.rejectRealtimeMediaSession(
        session.namespace,
        session.sessionId,
      );
      void this.finishSession(session, { notifyRemote: false });
      return;
    }

    try {
      session.callConfiguration = this.deps.resolveCallConfiguration();
    } catch (error) {
      this.deps.logger.info(
        { error, namespace: session.namespace, sessionId: session.sessionId },
        'Rejecting realtime session offer: no realtime provider configured',
      );
      await this.deps.mcp.rejectRealtimeMediaSession(
        session.namespace,
        session.sessionId,
      );
      void this.finishSession(session, { notifyRemote: false });
      return;
    }

    const lease = await this.acquireLease(session);
    if (!lease) return;
    session.lease = lease;
    if (session.controller.signal.aborted) return;

    const accepted = await this.deps.mcp.acceptRealtimeMediaSession(
      session.namespace,
      session.sessionId,
    );
    session.accepted = true;
    if (session.controller.signal.aborted) return;

    const descriptor = liveKitDescriptorFrom(accepted.transport);
    const transport = await this.deps.mediaTransportConnector.connect(
      descriptor,
      { signal: session.controller.signal },
    );
    session.transport = transport;
    if (session.controller.signal.aborted) {
      await transport.close();
      return;
    }

    const handle = await lease.bootstrap();
    if (session.controller.signal.aborted) {
      handle.rollback();
      return;
    }
    session.contextHandle = handle;

    const processor = await (
      session.callConfiguration?.processorFactory ?? this.deps.processorFactory
    ).create({
      namespace: session.namespace,
      sessionId: session.sessionId,
      signal: session.controller.signal,
      context: handle.context,
    });
    session.processor = processor;
    if (session.controller.signal.aborted) {
      await Promise.allSettled([transport.close(), processor.close()]);
      return;
    }
    this.settleContext(session, 'commit');

    await lease.commit({
      type: 'session-started',
      eventId: `realtime:${session.namespace}:${session.sessionId}:started`,
      timestamp: this.timestamp(),
    });

    const modelEventTask = this.consumeModelEvents(session, lease, processor);
    session.modelEventTask = modelEventTask;
    session.tasks.push(
      this.discoverAudioSources(session, transport, processor),
      this.forwardUpdates(session, lease, processor),
      this.monitorLease(session, lease),
      this.pipeAudio(
        session,
        processor.audioOutput,
        (frame) => transport.audioOutput.write(frame),
        'Realtime audio output failed',
      ),
      this.monitorTransport(session, transport),
      this.monitorProcessor(session, processor),
    );
    this.deps.logger.info(
      {
        namespace: session.namespace,
        externalMediaSessionId: session.sessionId,
        canonicalSessionId: lease.sessionId,
        leaseId: lease.id,
        historyRevision: handle.context.historyRevision,
        updateWatermark: handle.context.updateWatermark,
      },
      'Realtime session active',
    );
  }

  private async acquireLease(
    session: ActiveRealtimeSession,
  ): Promise<InteractionLease | undefined> {
    try {
      return await this.deps.conversationHost.acquireInteractionLease({
        mode: 'realtime',
        externalSessionId: session.sessionId,
        namespace: session.namespace,
        signal: session.acquisitionController.signal,
        model:
          session.callConfiguration?.model ??
          this.deps.resolveCallConfiguration().model,
      });
    } catch (error) {
      if (session.acquisitionController.signal.aborted) return undefined;
      this.deps.logger.info(
        { error, namespace: session.namespace, sessionId: session.sessionId },
        'Rejecting realtime session offer: no interaction lease available',
      );
      await this.deps.mcp
        .rejectRealtimeMediaSession(session.namespace, session.sessionId)
        .catch((rejectError: unknown) => {
          this.deps.logger.warn(
            {
              error: rejectError,
              namespace: session.namespace,
              sessionId: session.sessionId,
            },
            'Realtime session rejection failed',
          );
        });
      void this.finishSession(session, { notifyRemote: false });
      return undefined;
    }
  }

  private async forwardUpdates(
    session: ActiveRealtimeSession,
    lease: InteractionLease,
    processor: RealtimeModelSession,
  ): Promise<void> {
    try {
      for await (const update of lease.updates) {
        if (session.controller.signal.aborted) return;
        await this.forwardUpdate(lease, processor, update);
      }
    } catch (error) {
      if (!session.controller.signal.aborted)
        this.failSession(session, error, 'Realtime update forwarding failed');
    }
  }

  private async forwardUpdate(
    lease: InteractionLease,
    processor: RealtimeModelSession,
    update: InteractionUpdateEnvelope,
  ): Promise<void> {
    await processor.sendUpdate(update);
    lease.acknowledgeUpdate(update.sequence);
    this.deps.logger.debug(
      {
        leaseId: lease.id,
        canonicalSessionId: lease.sessionId,
        updateSequence: update.sequence,
        eventId: update.eventId,
        requestResponse: update.requestResponse,
      },
      'Forwarded canonical update to realtime provider',
    );
  }

  private async consumeModelEvents(
    session: ActiveRealtimeSession,
    lease: InteractionLease,
    processor: RealtimeModelSession,
  ): Promise<void> {
    try {
      for await (const event of processor.events) {
        if (session.controller.signal.aborted) return;
        await this.handleModelEvent(lease, processor, event);
      }
    } catch (error) {
      if (!session.controller.signal.aborted)
        this.failSession(
          session,
          error,
          'Realtime model event handling failed',
        );
    }
  }

  private async handleModelEvent(
    lease: InteractionLease,
    processor: RealtimeModelSession,
    event: RealtimeModelEvent,
  ): Promise<void> {
    if (event.type === 'invalid-tool-call') {
      await processor.sendToolResult(event.result);
      return;
    }
    if (event.type === 'approximate-transcript-group') {
      await lease.commit({
        ...event,
        timestamp: this.timestamp(),
      });
      return;
    }
    if (event.type !== 'tool-call') {
      await lease.commit({
        type: event.type,
        eventId: event.eventId,
        timestamp: this.timestamp(),
        text: event.text,
        ...(event.interrupted !== undefined && {
          interrupted: event.interrupted,
        }),
      });
      return;
    }
    await lease.commit({
      type: 'tool-call',
      eventId: event.eventId,
      timestamp: this.timestamp(),
      request: event.request,
    });
    this.deps.logger.debug(
      {
        leaseId: lease.id,
        canonicalSessionId: lease.sessionId,
        toolExecutionId: event.request.executionId,
        toolName: event.request.name,
      },
      'Executing realtime tool call through canonical session',
    );
    const result = await lease.executeTool(event.request);
    await lease.commit({
      type: 'tool-result',
      eventId: `${event.eventId}:result`,
      timestamp: this.timestamp(),
      result,
    });
    await processor.sendToolResult(result);
  }

  private async monitorLease(
    session: ActiveRealtimeSession,
    lease: InteractionLease,
  ): Promise<void> {
    const closure = await lease.closed;
    if (session.controller.signal.aborted) return;
    if (closure.type === 'failed') {
      this.failSession(session, closure.error, 'Realtime interaction failed');
      return;
    }
    if (closure.type === 'revoked') {
      this.deps.logger.info(
        {
          namespace: session.namespace,
          externalMediaSessionId: session.sessionId,
          canonicalSessionId: lease.sessionId,
          leaseId: lease.id,
          releaseReason: closure.reason,
        },
        'Realtime interaction lease revoked',
      );
    }
    void this.finishSession(session, { notifyRemote: session.accepted });
  }

  private async releaseLease(session: ActiveRealtimeSession): Promise<void> {
    const lease = session.lease;
    if (!lease) return;
    session.lease = undefined;
    const finalEvent = session.accepted
      ? {
          type: 'session-ended' as const,
          eventId: `realtime:${session.namespace}:${session.sessionId}:ended`,
          timestamp: this.timestamp(),
        }
      : undefined;
    await lease
      .release('realtime-session-ended', finalEvent)
      .catch((error: unknown) => {
        this.deps.logger.warn(
          {
            error,
            namespace: session.namespace,
            externalMediaSessionId: session.sessionId,
            canonicalSessionId: lease.sessionId,
            leaseId: lease.id,
            releaseReason: 'realtime-session-ended',
          },
          'Realtime interaction lease release failed',
        );
      });
  }

  private settleContext(
    session: ActiveRealtimeSession,
    outcome: 'commit' | 'rollback',
  ): void {
    if (session.contextSettled || !session.contextHandle) return;
    session.contextSettled = true;
    if (outcome === 'commit') session.contextHandle.commit();
    else session.contextHandle.rollback();
  }

  private timestamp(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private async discoverAudioSources(
    session: ActiveRealtimeSession,
    transport: MediaTransport,
    processor: RealtimeModelSession,
  ): Promise<void> {
    try {
      for await (const source of transport.audioSources) {
        if (session.controller.signal.aborted) return;
        await processor.audioInputs.attach(source);
      }
    } catch (error) {
      if (!session.controller.signal.aborted)
        this.failSession(session, error, 'Realtime media input failed');
    }
  }

  private async pipeAudio(
    session: ActiveRealtimeSession,
    readable: AsyncIterable<AudioFrame>,
    write: (frame: AudioFrame) => Promise<void>,
    failureMessage: string,
  ): Promise<void> {
    try {
      for await (const frame of readable) {
        if (session.controller.signal.aborted) return;
        await write(frame);
      }
    } catch (error) {
      if (!session.controller.signal.aborted)
        this.failSession(session, error, failureMessage);
    }
  }

  private async monitorTransport(
    session: ActiveRealtimeSession,
    transport: MediaTransport,
  ): Promise<void> {
    const closure = await transport.closed;
    if (session.controller.signal.aborted) return;
    if (closure.type === 'failed')
      this.failSession(
        session,
        closure.error,
        'Realtime media transport failed',
      );
    else void this.finishSession(session, { notifyRemote: true });
  }

  private async monitorProcessor(
    session: ActiveRealtimeSession,
    processor: RealtimeModelSession,
  ): Promise<void> {
    const closure = await processor.closed;
    if (session.controller.signal.aborted) return;
    if (closure.type === 'failed')
      this.failSession(
        session,
        closure.error,
        'Realtime audio processor failed',
      );
    else void this.finishSession(session, { notifyRemote: true });
  }

  private failSession(
    session: ActiveRealtimeSession,
    error: unknown,
    message: string,
  ): void {
    this.deps.logger.warn(
      {
        error,
        namespace: session.namespace,
        externalMediaSessionId: session.sessionId,
        canonicalSessionId: session.lease?.sessionId,
        leaseId: session.lease?.id,
      },
      message,
    );
    void this.finishSession(session, { notifyRemote: session.accepted });
  }

  private async handleAvailability(
    event: McpRealtimeMediaAvailability,
  ): Promise<void> {
    if (!this.started || event.available) return;
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((session) => session.namespace === event.namespace)
        .map((session) => this.finishSession(session, { notifyRemote: false })),
    );
  }

  private finishSession(
    session: ActiveRealtimeSession,
    options: { notifyRemote: boolean },
  ): Promise<void> {
    if (session.finish) return session.finish;
    session.finish = (async () => {
      if (!session.lease)
        session.acquisitionController.abort('realtime-session-ended');
      if (!session.processor)
        session.controller.abort('realtime-session-ended');
      const setupSettled = await waitForSettlement(
        [session.setup],
        TEARDOWN_PHASE_TIMEOUT_MS,
      );
      const lease = session.lease;
      if (!setupSettled) {
        this.logTeardownTimeout(session, lease, 'setup');
        session.controller.abort('realtime-session-ended');
      }
      const endpointsClosed = await waitForSettlement(
        [session.processor?.close(), session.transport?.close()],
        TEARDOWN_PHASE_TIMEOUT_MS,
      );
      if (!endpointsClosed) {
        this.logTeardownTimeout(session, lease, 'endpoint-close');
        session.controller.abort('realtime-session-ended');
      }
      if (endpointsClosed && session.modelEventTask) {
        const modelEventsDrained = await waitForSettlement(
          [session.modelEventTask],
          TEARDOWN_PHASE_TIMEOUT_MS,
        );
        if (!modelEventsDrained)
          this.logTeardownTimeout(session, lease, 'model-event-drain');
      }
      session.controller.abort('realtime-session-ended');
      this.settleContext(session, 'rollback');
      // Releasing closes the lease, which ends the update stream the pumps
      // iterate. External endpoint cleanup must not retain generation-lane
      // ownership indefinitely when a provider or media SDK fails to close.
      await this.releaseLease(session);
      const tasksSettled = await waitForSettlement(
        session.tasks,
        TEARDOWN_PHASE_TIMEOUT_MS,
      );
      if (!tasksSettled)
        this.logTeardownTimeout(session, lease, 'background-task-drain');
      if (options.notifyRemote && session.accepted && !session.endSent) {
        session.endSent = true;
        await this.deps.mcp
          .endRealtimeMediaSession(session.namespace, session.sessionId)
          .catch((error: unknown) => {
            this.deps.logger.warn(
              {
                error,
                namespace: session.namespace,
                sessionId: session.sessionId,
              },
              'Realtime session end request failed',
            );
          });
      }
      if (this.sessions.get(session.key) === session)
        this.sessions.delete(session.key);
      setRealtimeSessionCount(this.sessions.size);
      this.deps.logger.info(
        {
          namespace: session.namespace,
          externalMediaSessionId: session.sessionId,
          canonicalSessionId: lease?.sessionId,
          leaseId: lease?.id,
          releaseReason: 'realtime-session-ended',
        },
        'Realtime session ended',
      );
    })();
    return session.finish;
  }

  private logTeardownTimeout(
    session: ActiveRealtimeSession,
    lease: InteractionLease | undefined,
    phase: string,
  ): void {
    this.deps.logger.warn(
      {
        namespace: session.namespace,
        externalMediaSessionId: session.sessionId,
        canonicalSessionId: lease?.sessionId,
        leaseId: lease?.id,
        phase,
        timeoutMs: TEARDOWN_PHASE_TIMEOUT_MS,
      },
      'Realtime session teardown phase timed out',
    );
  }
}

export function createRealtimeSessionCoordinator(
  deps: RealtimeSessionCoordinatorDependencies,
): RealtimeSessionCoordinator {
  return new RealtimeSessionCoordinatorModule({
    logger: deps.logging.child({
      name: 'realtime-session',
      bindings: { module: 'realtime-session' },
    }),
    mcp: deps.mcp,
    mediaTransportConnector: deps.mediaTransportConnector,
    processorFactory: deps.processorFactory,
    conversationHost: deps.conversationHost,
    resolveCallConfiguration:
      deps.resolveCallConfiguration ??
      (() => {
        if (!deps.model) throw new Error('Realtime model is not configured');
        return {
          model: deps.resolveModel?.() ?? deps.model,
          processorFactory: deps.processorFactory,
        };
      }),
    now: deps.now ?? Date.now,
  });
}

async function waitForSettlement(
  tasks: readonly (Promise<unknown> | undefined)[],
  timeoutMs: number,
): Promise<boolean> {
  const pending = tasks.filter(
    (task): task is Promise<unknown> => task !== undefined,
  );
  if (pending.length === 0) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sessionKey(namespace: string, sessionId: string): string {
  return `${namespace}\u0000${sessionId}`;
}

function liveKitDescriptorFrom(
  transport: Awaited<
    ReturnType<Mcp['acceptRealtimeMediaSession']>
  >['transport'],
): LiveKitRoomTransportDescriptor {
  switch (transport.kind) {
    case 'livekit-room':
      return transport.descriptor;
    case 'unknown':
      throw new Error(
        `Unsupported media transport profile: ${transport.descriptor.profile}`,
      );
  }
}
