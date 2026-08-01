import { randomUUID } from 'node:crypto';

import type {
  AcceptRealtimeMediaSessionResult,
  RealtimeMediaSessionEndedNotificationParams,
  RealtimeMediaSessionOfferedNotificationParams,
} from '@stagewise/mcp-extension-realtime-media';
import { realtimeMediaSessionError } from '@stagewise/mcp-extension-realtime-media/server';

export const REALTIME_OFFER_TTL_MS = 30_000;

export type RealtimeTransportDescriptorResolver = (
  sessionId: string,
) =>
  | AcceptRealtimeMediaSessionResult
  | Promise<AcceptRealtimeMediaSessionResult>;

type SessionState = 'offered' | 'accepted' | 'rejected' | 'ended' | 'expired';

interface RealtimeSession {
  id: string;
  consumerKey: string;
  expiresAt: string;
  state: SessionState;
  accepted?: AcceptRealtimeMediaSessionResult;
  accepting?: Promise<AcceptRealtimeMediaSessionResult>;
}

export interface RealtimeSessionStore {
  createOffer(
    consumerKey: string,
  ): RealtimeMediaSessionOfferedNotificationParams;
  accept(
    consumerKey: string,
    sessionId: string,
  ): Promise<AcceptRealtimeMediaSessionResult>;
  reject(consumerKey: string, sessionId: string): void;
  end(consumerKey: string, sessionId: string): void;
  remoteEnd(
    consumerKey: string,
    sessionId: string,
    reason?: string,
  ): RealtimeMediaSessionEndedNotificationParams;
  endConsumer(consumerKey: string): void;
  close(): void;
}

class RealtimeSessionStoreModule implements RealtimeSessionStore {
  readonly #sessions = new Map<string, RealtimeSession>();

  constructor(
    private readonly resolveTransport: RealtimeTransportDescriptorResolver,
  ) {}

  createOffer(
    consumerKey: string,
  ): RealtimeMediaSessionOfferedNotificationParams {
    const session: RealtimeSession = {
      id: randomUUID(),
      consumerKey,
      expiresAt: new Date(Date.now() + REALTIME_OFFER_TTL_MS).toISOString(),
      state: 'offered',
    };
    this.#sessions.set(session.id, session);
    return { sessionId: session.id, expiresAt: session.expiresAt };
  }

  async accept(
    consumerKey: string,
    sessionId: string,
  ): Promise<AcceptRealtimeMediaSessionResult> {
    const session = this.#require(consumerKey, sessionId);
    this.#expire(session);
    if (session.state === 'expired')
      throw realtimeMediaSessionError('expired-offer', sessionId);
    if (session.state === 'accepted' && session.accepted)
      return structuredClone(session.accepted);
    if (session.accepting) return structuredClone(await session.accepting);
    if (session.state !== 'offered')
      throw realtimeMediaSessionError('invalid-state', sessionId);
    session.accepting = Promise.resolve(this.resolveTransport(sessionId)).then(
      (accepted) => {
        session.state = 'accepted';
        session.accepted = structuredClone(accepted);
        session.accepting = undefined;
        return accepted;
      },
    );
    try {
      return structuredClone(await session.accepting);
    } catch (error) {
      session.accepting = undefined;
      throw error;
    }
  }

  reject(consumerKey: string, sessionId: string): void {
    const session = this.#require(consumerKey, sessionId);
    this.#expire(session);
    if (session.state === 'rejected') return;
    if (session.state !== 'offered')
      throw realtimeMediaSessionError('invalid-state', sessionId);
    session.state = 'rejected';
  }

  end(consumerKey: string, sessionId: string): void {
    const session = this.#require(consumerKey, sessionId);
    if (session.state === 'ended') return;
    if (session.state !== 'accepted')
      throw realtimeMediaSessionError('invalid-state', sessionId);
    session.state = 'ended';
  }

  remoteEnd(
    consumerKey: string,
    sessionId: string,
    reason?: string,
  ): RealtimeMediaSessionEndedNotificationParams {
    const session = this.#require(consumerKey, sessionId);
    if (
      session.state !== 'offered' &&
      session.state !== 'accepted' &&
      session.state !== 'ended'
    ) {
      throw realtimeMediaSessionError('invalid-state', sessionId);
    }
    session.state = 'ended';
    return { sessionId, ...(reason ? { reason } : {}) };
  }

  endConsumer(consumerKey: string): void {
    for (const session of this.#sessions.values()) {
      if (
        session.consumerKey === consumerKey &&
        (session.state === 'offered' || session.state === 'accepted')
      ) {
        session.state = 'ended';
      }
    }
  }

  close(): void {
    this.#sessions.clear();
  }

  #require(consumerKey: string, sessionId: string): RealtimeSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.consumerKey !== consumerKey)
      throw realtimeMediaSessionError('unknown-session', sessionId);
    return session;
  }

  #expire(session: RealtimeSession): void {
    if (
      session.state === 'offered' &&
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      session.state = 'expired';
    }
  }
}

export function createRealtimeSessionStore(
  resolveTransport: RealtimeTransportDescriptorResolver = () => ({
    transport: {
      profile: 'livekit-room',
      url: 'wss://contract-only.livekit.invalid',
      token: 'contract-only-non-connectable-token',
    },
  }),
): RealtimeSessionStore {
  return new RealtimeSessionStoreModule(resolveTransport);
}
