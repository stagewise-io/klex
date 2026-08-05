import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import type {
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
  RealtimeProcessor,
  RealtimeProcessorFactory,
} from '@/media-transport';

export interface RealtimeSessionCoordinator {
  start(): Promise<void>;
  close(): Promise<void>;
  getActiveSessionCount(): number;
}

export interface RealtimeSessionCoordinatorDependencies {
  logging: RootLogger;
  mcp: Mcp;
  mediaTransportConnector: MediaTransportConnector;
  processorFactory: RealtimeProcessorFactory;
  now?: () => number;
}

interface ActiveRealtimeSession {
  key: string;
  namespace: string;
  sessionId: string;
  controller: AbortController;
  accepted: boolean;
  endSent: boolean;
  transport?: MediaTransport;
  processor?: RealtimeProcessor;
  setup?: Promise<void>;
  tasks: Promise<void>[];
  finish?: Promise<void>;
}

class RealtimeSessionCoordinatorModule implements RealtimeSessionCoordinator {
  private readonly sessions = new Map<string, ActiveRealtimeSession>();
  private started = false;
  private notificationUnsubscribe: (() => void) | undefined;
  private availabilityUnsubscribe: (() => void) | undefined;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      mcp: Mcp;
      mediaTransportConnector: MediaTransportConnector;
      processorFactory: RealtimeProcessorFactory;
      now: () => number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.notificationUnsubscribe = this.deps.mcp.onRealtimeMediaNotification(
      (event) => this.handleNotification(event),
    );
    this.availabilityUnsubscribe = this.deps.mcp.onRealtimeMediaAvailability(
      (event) => this.handleAvailability(event),
    );
    this.deps.logger.info('Realtime session coordinator started');
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = undefined;
    this.availabilityUnsubscribe?.();
    this.availabilityUnsubscribe = undefined;
    await Promise.allSettled(
      [...this.sessions.values()].map((session) =>
        this.finishSession(session, { notifyRemote: session.accepted }),
      ),
    );
    this.deps.logger.info('Realtime session coordinator stopped');
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
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
      accepted: false,
      endSent: false,
      tasks: [],
    };
    this.sessions.set(key, session);
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

    const accepted = await this.deps.mcp.acceptRealtimeMediaSession(
      session.namespace,
      session.sessionId,
    );
    session.accepted = true;
    if (session.controller.signal.aborted) return;

    const transport = await this.deps.mediaTransportConnector.connect(
      accepted.transport,
      { signal: session.controller.signal },
    );
    session.transport = transport;
    if (session.controller.signal.aborted) {
      await transport.close();
      return;
    }

    const processor = await this.deps.processorFactory.create({
      namespace: session.namespace,
      sessionId: session.sessionId,
      signal: session.controller.signal,
    });
    session.processor = processor;
    if (session.controller.signal.aborted) {
      await Promise.allSettled([transport.close(), processor.close()]);
      return;
    }

    session.tasks.push(
      this.discoverAudioSources(session, transport, processor),
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
      { namespace: session.namespace, sessionId: session.sessionId },
      'Realtime session active',
    );
  }

  private async discoverAudioSources(
    session: ActiveRealtimeSession,
    transport: MediaTransport,
    processor: RealtimeProcessor,
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
    processor: RealtimeProcessor,
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
      { error, namespace: session.namespace, sessionId: session.sessionId },
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
      session.controller.abort('realtime-session-ended');
      await session.setup;
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
      await Promise.allSettled([
        ...session.tasks,
        session.processor?.close(),
        session.transport?.close(),
      ]);
      if (this.sessions.get(session.key) === session)
        this.sessions.delete(session.key);
      this.deps.logger.info(
        { namespace: session.namespace, sessionId: session.sessionId },
        'Realtime session ended',
      );
    })();
    return session.finish;
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
    now: deps.now ?? Date.now,
  });
}

function sessionKey(namespace: string, sessionId: string): string {
  return `${namespace}\u0000${sessionId}`;
}
