import { randomUUID } from 'node:crypto';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  DeviceAuthorizationChallenge,
  ProviderAuthorization,
  ProviderAuthorizationStarted,
  ProviderInstance,
  ProviderInstanceId,
  ProviderOperationResult,
} from '../provider-registry';
import type {
  ProviderCredentialManager,
  ProviderHookRunner,
} from './credential-manager';

const MAX_BACKOFF_MS = 60_000;
/**
 * An approved poll makes two HTTPS calls (device token, then the single-use
 * code exchange), so it gets more time than the default hook deadline.
 */
const POLL_TIMEOUT_MS = 60_000;

export type DeviceAuthorizationState = 'pending' | 'expired' | 'failed';

export interface DeviceAuthorizationStatus {
  state: DeviceAuthorizationState;
  id: string;
  expiresAt: string;
  message?: string;
}

interface Attempt {
  id: string;
  challenge: DeviceAuthorizationChallenge;
  controller: AbortController;
  state: DeviceAuthorizationState;
  message?: string;
}

/**
 * Process-local device-code sign-ins. One attempt per provider instance;
 * the poll loop runs in the background so callers never block on approval.
 * Attempts do not survive restarts by design: the user code is short-lived.
 */
export class DeviceAuthorizations {
  private readonly attempts = new Map<ProviderInstanceId, Attempt>();
  private readonly starting = new Map<
    ProviderInstanceId,
    Promise<ProviderOperationResult<ProviderAuthorizationStarted>>
  >();
  /** Bumped on cancel so a start still awaiting its challenge is discarded. */
  private readonly epochs = new Map<ProviderInstanceId, number>();
  private closed = false;

  public constructor(
    private readonly deps: {
      runHook: ProviderHookRunner;
      credentials: ProviderCredentialManager;
      logger: ModuleLogger;
      onAuthorized: (id: ProviderInstanceId) => void;
      now?: () => number;
    },
  ) {}

  public start(
    instance: ProviderInstance,
    authorization: ProviderAuthorization,
  ): Promise<ProviderOperationResult<ProviderAuthorizationStarted>> {
    if (this.closed) return Promise.resolve(cancelled());
    const live = this.attempts.get(instance.id);
    if (live?.state === 'pending' && !this.isExpired(live))
      return Promise.resolve({
        ok: true,
        code: 'available',
        value: started(live),
      });
    const pending = this.starting.get(instance.id);
    if (pending) return pending;
    const request = this.startNow(instance, authorization).finally(() => {
      if (this.starting.get(instance.id) === request)
        this.starting.delete(instance.id);
    });
    this.starting.set(instance.id, request);
    return request;
  }

  public status(id: ProviderInstanceId): DeviceAuthorizationStatus | undefined {
    const attempt = this.attempts.get(id);
    if (!attempt) return undefined;
    if (attempt.state === 'pending' && this.isExpired(attempt))
      this.finish(attempt, 'expired');
    return {
      state: attempt.state,
      id: attempt.id,
      expiresAt: attempt.challenge.expiresAt,
      ...(attempt.message && { message: attempt.message }),
    };
  }

  /** Cancels a pending attempt or a start still awaiting its challenge. */
  public cancel(id: ProviderInstanceId): boolean {
    this.epochs.set(id, this.epoch(id) + 1);
    const starting = this.starting.delete(id);
    const attempt = this.attempts.get(id);
    if (!attempt) return starting;
    attempt.controller.abort();
    this.attempts.delete(id);
    return true;
  }

  public close(): void {
    this.closed = true;
    for (const attempt of this.attempts.values()) attempt.controller.abort();
    this.attempts.clear();
    this.starting.clear();
  }

  private async startNow(
    instance: ProviderInstance,
    authorization: ProviderAuthorization,
  ): Promise<ProviderOperationResult<ProviderAuthorizationStarted>> {
    const epoch = this.epoch(instance.id);
    const result = await this.deps.runHook((signal) =>
      authorization.start(instance, signal),
    );
    if (this.closed || epoch !== this.epoch(instance.id)) return cancelled();
    if (!result.ok) return result;
    this.attempts.get(instance.id)?.controller.abort();
    const attempt: Attempt = {
      id: randomUUID(),
      challenge: result.value,
      controller: new AbortController(),
      state: 'pending',
    };
    this.attempts.set(instance.id, attempt);
    this.deps.logger.info(
      { providerId: instance.id, attemptId: attempt.id },
      'Provider device authorization started',
    );
    void this.run(instance, authorization, attempt);
    return { ok: true, code: 'available', value: started(attempt) };
  }

  private async run(
    instance: ProviderInstance,
    authorization: ProviderAuthorization,
    attempt: Attempt,
  ): Promise<void> {
    const { signal } = attempt.controller;
    const interval = Math.max(0, attempt.challenge.intervalMs);
    let delay = interval;
    let failures = 0;
    while (!signal.aborted) {
      await sleep(delay, signal);
      if (signal.aborted) return;
      if (this.isExpired(attempt)) {
        this.finish(attempt, 'expired');
        return;
      }
      const result = await this.deps.runHook(
        // Cancel and shutdown abort the in-flight poll, not only the loop.
        (hookSignal) =>
          authorization.poll(
            instance,
            attempt.challenge.handle,
            AbortSignal.any([hookSignal, signal]),
          ),
        { timeoutMs: POLL_TIMEOUT_MS },
      );
      if (signal.aborted) return;

      if (result.ok) {
        const poll = result.value;
        if (poll.status === 'pending') {
          failures = 0;
          delay = interval;
          continue;
        }
        try {
          await this.deps.credentials.save(instance, poll.credential);
        } catch {
          this.finish(attempt, 'failed', 'Could not store the credential');
          return;
        }
        // A sign-out during the write wins; the manager kept nothing.
        if (signal.aborted) return;
        if (this.attempts.get(instance.id) === attempt)
          this.attempts.delete(instance.id);
        this.deps.logger.info(
          { providerId: instance.id, attemptId: attempt.id },
          'Provider device authorization completed',
        );
        this.deps.onAuthorized(instance.id);
        return;
      }
      if (result.code === 'authentication_required') {
        this.finish(attempt, 'failed', result.message);
        return;
      }
      failures += 1;
      delay = Math.min(
        Math.max(interval, 1_000) * 2 ** failures,
        MAX_BACKOFF_MS,
      );
      this.deps.logger.warn(
        { providerId: instance.id, attemptId: attempt.id, code: result.code },
        'Provider device authorization poll failed',
      );
    }
  }

  private finish(
    attempt: Attempt,
    state: Exclude<DeviceAuthorizationState, 'pending'>,
    message?: string,
  ): void {
    attempt.state = state;
    if (message) attempt.message = message;
    attempt.controller.abort();
  }

  private epoch(id: ProviderInstanceId): number {
    return this.epochs.get(id) ?? 0;
  }

  private isExpired(attempt: Attempt): boolean {
    const expiresAt = Date.parse(attempt.challenge.expiresAt);
    return Number.isFinite(expiresAt) && this.now() >= expiresAt;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function started(attempt: Attempt): ProviderAuthorizationStarted {
  return {
    id: attempt.id,
    verificationUri: attempt.challenge.verificationUri,
    userCode: attempt.challenge.userCode,
    expiresAt: attempt.challenge.expiresAt,
  };
}

function cancelled(): ProviderOperationResult<never> {
  return {
    ok: false,
    code: 'conflict',
    message: 'The sign-in was cancelled',
    remediation: 'Start the sign-in again.',
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}
