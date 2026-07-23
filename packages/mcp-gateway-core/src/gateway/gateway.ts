import type {
  EnvironmentConnection,
  Unsubscribe,
} from '../connection/index.js';
import type {
  AgentPrincipal,
  EnvironmentId,
  EnvironmentPrincipal,
  GatewayAuthorization,
} from '../identity/index.js';
import {
  createGatewaySessionId,
  GATEWAY_PROTOCOL_VERSION,
  type GatewaySessionId,
  type SessionMessageFrame,
} from '../protocol/index.js';

export type GatewayMessage = SessionMessageFrame['message'];

export interface GatewaySession {
  readonly id: GatewaySessionId;
  send(message: GatewayMessage): Promise<void>;
  onMessage(handler: (message: GatewayMessage) => void): Unsubscribe;
  onClose(handler: (cause?: Error) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface EnvironmentRegistration {
  close(): Promise<void>;
}

export interface Gateway {
  registerEnvironment(
    principal: EnvironmentPrincipal,
    connection: EnvironmentConnection,
  ): EnvironmentRegistration;
  openSession(
    agent: AgentPrincipal,
    environmentId: EnvironmentId,
    options?: { readonly signal?: AbortSignal },
  ): Promise<GatewaySession>;
  close(): Promise<void>;
}

export interface GatewayDependencies {
  readonly authorization: GatewayAuthorization;
  readonly createSessionId?: () => GatewaySessionId;
  readonly sessionOpenTimeoutMs?: number;
}

interface Registration {
  readonly principal: EnvironmentPrincipal;
  readonly connection: EnvironmentConnection;
  readonly sessions: Set<SessionModule>;
  readonly unsubscribe: Unsubscribe[];
  active: boolean;
}

class SessionModule implements GatewaySession {
  readonly id: GatewaySessionId;

  readonly #registration: Registration;
  readonly #onEnded: () => void;
  readonly #messageHandlers = new Set<(message: GatewayMessage) => void>();
  readonly #closeHandlers = new Set<(cause?: Error) => void>();
  #closed = false;

  constructor(
    id: GatewaySessionId,
    registration: Registration,
    onEnded: () => void,
  ) {
    this.id = id;
    this.#registration = registration;
    this.#onEnded = onEnded;
  }

  async send(message: GatewayMessage): Promise<void> {
    if (this.#closed) throw new Error('Gateway session is closed');
    await this.#registration.connection.send({
      version: GATEWAY_PROTOCOL_VERSION,
      type: 'session.message',
      sessionId: this.id,
      message,
    });
  }

  onMessage(handler: (message: GatewayMessage) => void): Unsubscribe {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onClose(handler: (cause?: Error) => void): Unsubscribe {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.end();
    await this.#registration.connection.send({
      version: GATEWAY_PROTOCOL_VERSION,
      type: 'session.close',
      sessionId: this.id,
    });
  }

  receive(message: GatewayMessage): void {
    if (this.#closed) return;
    for (const handler of this.#messageHandlers) handler(message);
  }

  end(cause?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onEnded();
    for (const handler of this.#closeHandlers) handler(cause);
    this.#messageHandlers.clear();
    this.#closeHandlers.clear();
  }
}

class GatewayModule implements Gateway {
  readonly #authorization: GatewayAuthorization;
  readonly #createSessionId: () => GatewaySessionId;
  readonly #sessionOpenTimeoutMs: number;
  readonly #registrations = new Map<string, Registration>();
  readonly #sessions = new Map<GatewaySessionId, SessionModule>();
  readonly #opening = new Map<GatewaySessionId, () => void>();
  #closed = false;

  constructor(dependencies: GatewayDependencies) {
    this.#authorization = dependencies.authorization;
    this.#createSessionId =
      dependencies.createSessionId ??
      (() => createGatewaySessionId(globalThis.crypto.randomUUID()));
    this.#sessionOpenTimeoutMs = dependencies.sessionOpenTimeoutMs ?? 30_000;
    if (
      !Number.isFinite(this.#sessionOpenTimeoutMs) ||
      this.#sessionOpenTimeoutMs <= 0
    ) {
      throw new RangeError('Session open timeout must be a positive number');
    }
  }

  registerEnvironment(
    principal: EnvironmentPrincipal,
    connection: EnvironmentConnection,
  ): EnvironmentRegistration {
    if (this.#closed) throw new Error('Gateway is closed');

    const key = environmentKey(principal);
    const registration: Registration = {
      principal,
      connection,
      sessions: new Set(),
      unsubscribe: [],
      active: true,
    };

    registration.unsubscribe.push(
      connection.onFrame((frame) => {
        if (!registration.active) return;

        const session = this.#sessions.get(frame.sessionId);
        if (frame.type === 'session.opened') {
          const resolve = this.#opening.get(frame.sessionId);
          if (!resolve || !session || !registration.sessions.has(session))
            return;
          this.#opening.delete(frame.sessionId);
          resolve();
          return;
        }

        if (!session || !registration.sessions.has(session)) {
          if (frame.type === 'session.message') {
            void this.#stopRegistration(
              registration,
              new Error('Environment sent a message for an unknown session'),
              true,
            ).catch(() => undefined);
          }
          return;
        }

        if (frame.type === 'session.message') session.receive(frame.message);
        else session.end(frame.reason ? new Error(frame.reason) : undefined);
      }),
      connection.onClose((cause) => {
        void this.#stopRegistration(
          registration,
          cause ?? new Error('Environment disconnected'),
          false,
        );
      }),
    );

    const previous = this.#registrations.get(key);
    this.#registrations.set(key, registration);
    if (previous) {
      void this.#stopRegistration(
        previous,
        new Error('Environment connection replaced'),
        true,
      ).catch(() => undefined);
    }

    return {
      close: () =>
        this.#stopRegistration(
          registration,
          new Error('Environment unregistered'),
          true,
        ),
    };
  }

  async openSession(
    agent: AgentPrincipal,
    environmentId: EnvironmentId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<GatewaySession> {
    if (this.#closed) throw new Error('Gateway is closed');
    if (options.signal?.aborted) throw abortError();

    const registration = this.#registrations.get(
      environmentKey({ tenantId: agent.tenantId, environmentId }),
    );
    if (!registration?.active) throw new Error('Environment is unavailable');

    if (!(await this.#authorization.authorize(agent, registration.principal))) {
      throw new Error('Agent is not authorized for this environment');
    }
    if (!registration.active) throw new Error('Environment is unavailable');

    const id = this.#createSessionId();
    if (this.#sessions.has(id)) throw new Error('Duplicate gateway session ID');

    const session = new SessionModule(id, registration, () => {
      registration.sessions.delete(session);
      this.#sessions.delete(id);
      this.#opening.delete(id);
    });
    registration.sessions.add(session);
    this.#sessions.set(id, session);

    const opened = Promise.withResolvers<void>();
    void opened.promise.catch(() => undefined);
    this.#opening.set(id, opened.resolve);

    const cancelOpening = (cause: Error) => {
      session.end(cause);
      void registration.connection
        .send({
          version: GATEWAY_PROTOCOL_VERSION,
          type: 'session.close',
          sessionId: id,
        })
        .catch(() => undefined);
    };
    const onAbort = () => cancelOpening(abortError());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => cancelOpening(new Error('Session opening timed out')),
      this.#sessionOpenTimeoutMs,
    );

    const unsubscribeClose = session.onClose((cause) => {
      opened.reject(cause ?? new Error('Session closed before it opened'));
    });

    try {
      await registration.connection.send({
        version: GATEWAY_PROTOCOL_VERSION,
        type: 'session.open',
        sessionId: id,
      });
      await opened.promise;
      if (options.signal?.aborted) throw abortError();
      return session;
    } catch (cause) {
      session.end(cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      unsubscribeClose();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const registrations = [...this.#registrations.values()];
    await Promise.allSettled(
      registrations.map((registration) =>
        this.#stopRegistration(registration, new Error('Gateway closed'), true),
      ),
    );
  }

  #stopRegistration(
    registration: Registration,
    cause: Error,
    closeConnection: boolean,
  ): Promise<void> {
    if (!registration.active) return Promise.resolve();
    registration.active = false;
    for (const unsubscribe of registration.unsubscribe) unsubscribe();
    registration.unsubscribe.length = 0;

    const key = environmentKey(registration.principal);
    if (this.#registrations.get(key) === registration) {
      this.#registrations.delete(key);
    }

    for (const session of [...registration.sessions]) session.end(cause);
    return closeConnection
      ? registration.connection.close()
      : Promise.resolve();
  }
}

export function createGateway(dependencies: GatewayDependencies): Gateway {
  return new GatewayModule(dependencies);
}

function environmentKey(
  identity: Pick<EnvironmentPrincipal, 'tenantId' | 'environmentId'>,
): string {
  return JSON.stringify([identity.tenantId, identity.environmentId]);
}

function abortError(): Error {
  const error = new Error('Session opening aborted');
  error.name = 'AbortError';
  return error;
}
