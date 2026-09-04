import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * A live authorization request that is waiting for callback parameters to be
 * delivered out of band (through Klex Cloud). Each entry corresponds to a
 * connection attempt that is currently blocked inside `connectMcpServer`, so
 * entries are inherently in-memory and are lost on restart.
 */
export interface PendingAuthorization {
  /** Opaque identifier, safe to expose. */
  id: string;
  /** MCP server namespace as configured. */
  serverName: string;
  /** Remote MCP server URL. */
  serverUrl: string;
  /** Authorization server URL the user must visit. */
  authorizationUrl: string;
  /** OAuth `state` parameter — the only secret guarding the callback sink. */
  state: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Listing shape. `authorizationUrl` and `state` are withheld: `state` is the
 * capability that authorizes a callback, and the authorization URL embeds it.
 */
export type PendingAuthorizationInfo = Omit<
  PendingAuthorization,
  'authorizationUrl' | 'state'
>;

export class PendingAuthorizationError extends Error {}

type Waiter = (authorization: PendingAuthorization | undefined) => void;

interface PendingEntry {
  authorization: PendingAuthorization;
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (params: URLSearchParams) => void;
}

/**
 * Tracks authorization requests that are parked waiting for a cloud-delivered
 * callback. Unlike the local flow there is no global queue: several MCP servers
 * may hold a pending authorization at the same time.
 */
export class McpPendingAuthorizationRegistry {
  private readonly byState = new Map<string, PendingEntry>();
  private readonly byId = new Map<string, PendingEntry>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  /**
   * Registers a pending authorization and returns a promise that settles with
   * the callback parameters, or rejects on timeout, abort, cancellation or
   * shutdown. The entry is always removed before the promise settles, which
   * makes every authorization single-use.
   */
  public register(
    input: Pick<
      PendingAuthorization,
      'serverName' | 'serverUrl' | 'authorizationUrl' | 'state'
    >,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<URLSearchParams> {
    if (options.signal.aborted) {
      return Promise.reject(
        new PendingAuthorizationError('OAuth authorization was canceled'),
      );
    }
    if (this.byState.has(input.state)) {
      return Promise.reject(
        new PendingAuthorizationError(
          'An OAuth authorization with this state is already pending',
        ),
      );
    }

    const now = Date.now();
    const authorization: PendingAuthorization = {
      id: randomUUID(),
      serverName: input.serverName,
      serverUrl: input.serverUrl,
      authorizationUrl: input.authorizationUrl,
      state: input.state,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + options.timeoutMs).toISOString(),
    };

    return new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(
          authorization.state,
          new PendingAuthorizationError('OAuth authorization timed out'),
        );
      }, options.timeoutMs);
      timer.unref?.();

      const onAbort = () => {
        this.settle(
          authorization.state,
          new PendingAuthorizationError('OAuth authorization was canceled'),
        );
      };
      options.signal.addEventListener('abort', onAbort, { once: true });

      const entry: PendingEntry = {
        authorization,
        cleanup: () => {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', onAbort);
        },
        reject,
        resolve,
      };
      this.byState.set(authorization.state, entry);
      this.byId.set(authorization.id, entry);
      this.notifyWaiters(authorization);
    });
  }

  /**
   * Delivers callback parameters for a pending authorization. Returns
   * `'unknown'` for an unknown, expired or already-consumed `state`, so a
   * replayed callback is indistinguishable from a bogus one.
   */
  public complete(
    state: string,
    params: URLSearchParams,
  ): 'accepted' | 'unknown' {
    const entry = this.findByState(state);
    if (!entry) return 'unknown';

    this.remove(entry);
    entry.cleanup();

    const error = params.get('error');
    if (error) {
      entry.reject(
        new PendingAuthorizationError(
          'OAuth authorization was denied or failed',
        ),
      );
      return 'accepted';
    }
    if (!params.get('code')) {
      entry.reject(
        new PendingAuthorizationError(
          'OAuth callback did not include an authorization code',
        ),
      );
      return 'accepted';
    }
    entry.resolve(new URLSearchParams(params));
    return 'accepted';
  }

  public list(): PendingAuthorizationInfo[] {
    return [...this.byId.values()]
      .map((entry) => toInfo(entry.authorization))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public findByServer(serverName: string): PendingAuthorization | undefined {
    for (const entry of this.byId.values()) {
      if (entry.authorization.serverName === serverName)
        return entry.authorization;
    }
    return undefined;
  }

  public cancel(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.settle(
      entry.authorization.state,
      new PendingAuthorizationError('OAuth authorization was canceled'),
    );
    return true;
  }

  /**
   * Resolves with a pending authorization for the given server — immediately if
   * one already exists, otherwise as soon as a connection attempt registers
   * one. Resolves with `undefined` if none appears within `timeoutMs`.
   */
  public waitForServer(
    serverName: string,
    timeoutMs: number,
  ): Promise<PendingAuthorization | undefined> {
    const existing = this.findByServer(serverName);
    if (existing) return Promise.resolve(existing);

    return new Promise<PendingAuthorization | undefined>((resolve) => {
      const waiter: Waiter = (authorization) => {
        clearTimeout(timer);
        this.removeWaiter(serverName, waiter);
        resolve(authorization);
      };
      const timer = setTimeout(() => {
        this.removeWaiter(serverName, waiter);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();

      const waiters = this.waiters.get(serverName) ?? new Set<Waiter>();
      waiters.add(waiter);
      this.waiters.set(serverName, waiters);
    });
  }

  public closeAll(): void {
    for (const entry of [...this.byId.values()]) {
      this.settle(
        entry.authorization.state,
        new PendingAuthorizationError('OAuth authorization registry closed'),
      );
    }
    // Callers blocked in `waitForServer` must not linger until their timer
    // fires: shutdown means no authorization will ever materialize.
    for (const waiters of [...this.waiters.values()]) {
      for (const waiter of [...waiters]) waiter(undefined);
    }
    this.waiters.clear();
  }

  private settle(state: string, error: Error): void {
    const entry = this.byState.get(state);
    if (!entry) return;
    this.remove(entry);
    entry.cleanup();
    entry.reject(error);
  }

  private remove(entry: PendingEntry): void {
    this.byState.delete(entry.authorization.state);
    this.byId.delete(entry.authorization.id);
  }

  /**
   * Looks a `state` up with timing-safe per-entry compares. The scan itself is
   * not constant-time — it stops at the first match, and length mismatches
   * short-circuit — which is acceptable because states are high-entropy random
   * values, so nothing about the secret leaks through position or length.
   */
  private findByState(state: string): PendingEntry | undefined {
    for (const [candidate, entry] of this.byState) {
      if (secureEqual(candidate, state)) return entry;
    }
    return undefined;
  }

  private notifyWaiters(authorization: PendingAuthorization): void {
    const waiters = this.waiters.get(authorization.serverName);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter(authorization);
  }

  private removeWaiter(serverName: string, waiter: Waiter): void {
    const waiters = this.waiters.get(serverName);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.waiters.delete(serverName);
  }
}

function toInfo(authorization: PendingAuthorization): PendingAuthorizationInfo {
  const { authorizationUrl: _url, state: _state, ...info } = authorization;
  return info;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
