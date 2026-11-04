import type { ModuleLogger } from '@stagewise/logger';

import type {
  ProviderAuthorization,
  ProviderContext,
  ProviderCredential,
  ProviderInstance,
  ProviderInstanceId,
  ProviderOperationFailure,
  ProviderOperationResult,
} from '../provider-registry';
import type {
  ProviderCredentialStore,
  StoredProviderAuthorization,
  StoredProviderCredential,
} from './credential-store';

/** Refresh when the access token expires within this window. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** A forced refresh right after another refresh reuses the fresh token. */
const INVALIDATE_DEBOUNCE_MS = 30_000;

export type ProviderHookRunner = <T>(
  operation: (
    signal: AbortSignal,
  ) => Promise<ProviderOperationResult<T> | undefined>,
  options?: { timeoutMs?: number },
) => Promise<ProviderOperationResult<T>>;

/** Transient credential failure surfaced to provider request code. */
export class ProviderCredentialError extends Error {
  public constructor(public readonly failure: ProviderOperationFailure) {
    super(failure.message);
    this.name = 'ProviderCredentialError';
  }
}

/**
 * In-memory view of the credential store with serialized refresh. The
 * snapshot keeps `instanceInfo` synchronous; the store is the durable copy.
 */
export class ProviderCredentialManager {
  private snapshot = new Map<ProviderInstanceId, StoredProviderAuthorization>();
  private readonly refreshes = new Map<
    ProviderInstanceId,
    Promise<ProviderCredential | undefined>
  >();
  private readonly lastRefresh = new Map<ProviderInstanceId, number>();
  /** Bumped on save/delete so in-flight refreshes cannot resurrect stale state. */
  private readonly generations = new Map<ProviderInstanceId, number>();

  public constructor(
    private readonly deps: {
      store?: ProviderCredentialStore;
      runHook: ProviderHookRunner;
      logger: ModuleLogger;
      now?: () => number;
    },
  ) {}

  public async load(): Promise<void> {
    if (!this.deps.store) return;
    this.snapshot = new Map(Object.entries(await this.deps.store.load()));
  }

  public record(
    id: ProviderInstanceId,
  ): StoredProviderAuthorization | undefined {
    return this.snapshot.get(id);
  }

  /**
   * Stores a new sign-in. Unlike refresh, a write failure propagates: the
   * caller reports the sign-in as failed instead of keeping a credential that
   * a restart would lose.
   */
  public async save(
    instance: ProviderInstance,
    credential: ProviderCredential,
  ): Promise<void> {
    this.bump(instance.id);
    const generation = this.generation(instance.id);
    const stored = toStored(credential, this.now());
    try {
      await this.deps.store?.save(instance.id, instance.type, stored);
    } catch (error) {
      this.deps.logger.error(
        { providerId: instance.id },
        'Failed to persist provider credential',
      );
      throw error;
    }
    // A sign-out or removal during the write wins.
    if (generation !== this.generation(instance.id)) return;
    // The refresh debounce belongs to the previous credential.
    this.lastRefresh.delete(instance.id);
    this.snapshot.set(instance.id, {
      type: instance.type,
      status: 'authorized',
      credential: stored,
    });
  }

  public async delete(id: ProviderInstanceId): Promise<boolean> {
    this.bump(id);
    this.lastRefresh.delete(id);
    const existed = this.snapshot.delete(id);
    const stored = (await this.deps.store?.delete(id)) ?? false;
    return existed || stored;
  }

  public contextFor(
    instance: ProviderInstance,
    authorization: ProviderAuthorization,
  ): ProviderContext {
    return {
      credential: async () => {
        const current = this.authorized(instance.id);
        if (!current) return undefined;
        if (!this.expiresSoon(current)) return toCredential(current);
        return this.refresh(instance, authorization, current.accessToken);
      },
      invalidate: async () => {
        const current = this.authorized(instance.id);
        if (!current) return undefined;
        const pending = this.refreshes.get(instance.id);
        if (pending) return pending;
        const last = this.lastRefresh.get(instance.id);
        if (last !== undefined && this.now() - last < INVALIDATE_DEBOUNCE_MS)
          return toCredential(current);
        return this.refresh(instance, authorization, current.accessToken);
      },
    };
  }

  private refresh(
    instance: ProviderInstance,
    authorization: ProviderAuthorization,
    staleAccessToken: string,
  ): Promise<ProviderCredential | undefined> {
    const pending = this.refreshes.get(instance.id);
    if (pending) return pending;
    const request = this.refreshNow(
      instance,
      authorization,
      staleAccessToken,
    ).finally(() => {
      if (this.refreshes.get(instance.id) === request)
        this.refreshes.delete(instance.id);
    });
    this.refreshes.set(instance.id, request);
    return request;
  }

  private async refreshNow(
    instance: ProviderInstance,
    authorization: ProviderAuthorization,
    staleAccessToken: string,
  ): Promise<ProviderCredential | undefined> {
    const current = this.authorized(instance.id);
    if (!current) return undefined;
    // Another caller already rotated the token while this one waited.
    if (current.accessToken !== staleAccessToken) return toCredential(current);

    const generation = this.generation(instance.id);
    const result = await this.deps.runHook((signal) =>
      authorization.refresh(instance, toCredential(current), signal),
    );
    if (generation !== this.generation(instance.id)) {
      const latest = this.authorized(instance.id);
      return latest && toCredential(latest);
    }

    if (result.ok) {
      const now = this.now();
      this.lastRefresh.set(instance.id, now);
      await this.persist(instance, {
        ...toStored(result.value, now),
        obtainedAt: current.obtainedAt,
        refreshedAt: new Date(now).toISOString(),
      });
      this.deps.logger.info(
        { providerId: instance.id },
        'Provider credential refreshed',
      );
      return result.value;
    }

    if (result.code === 'authentication_required') {
      await this.revoke(instance, result.message);
      return undefined;
    }

    this.deps.logger.warn(
      { providerId: instance.id, code: result.code },
      'Provider credential refresh failed',
    );
    throw new ProviderCredentialError(result);
  }

  private async revoke(
    instance: ProviderInstance,
    message: string,
  ): Promise<void> {
    this.bump(instance.id);
    const failure = {
      code: 'authentication_required',
      message,
      at: new Date(this.now()).toISOString(),
    };
    this.snapshot.set(instance.id, {
      type: instance.type,
      status: 'revoked',
      failure,
    });
    this.deps.logger.warn(
      { providerId: instance.id },
      'Provider credential revoked',
    );
    try {
      await this.deps.store?.markRevoked(instance.id, instance.type, failure);
    } catch {
      this.deps.logger.error(
        { providerId: instance.id },
        'Failed to persist provider credential revocation',
      );
    }
  }

  /**
   * Refresh tokens are single use, so the in-memory snapshot is updated even
   * when persistence fails; otherwise the running process would lose access.
   */
  private async persist(
    instance: ProviderInstance,
    credential: StoredProviderCredential,
  ): Promise<void> {
    this.snapshot.set(instance.id, {
      type: instance.type,
      status: 'authorized',
      credential,
    });
    try {
      await this.deps.store?.save(instance.id, instance.type, credential);
    } catch {
      this.deps.logger.error(
        { providerId: instance.id },
        'Failed to persist provider credential',
      );
    }
  }

  private authorized(
    id: ProviderInstanceId,
  ): StoredProviderCredential | undefined {
    const record = this.snapshot.get(id);
    return record?.status === 'authorized' ? record.credential : undefined;
  }

  private expiresSoon(credential: StoredProviderCredential): boolean {
    if (!credential.expiresAt) return false;
    const expiresAt = Date.parse(credential.expiresAt);
    return (
      Number.isFinite(expiresAt) && expiresAt - this.now() < REFRESH_MARGIN_MS
    );
  }

  private generation(id: ProviderInstanceId): number {
    return this.generations.get(id) ?? 0;
  }

  private bump(id: ProviderInstanceId): void {
    this.generations.set(id, this.generation(id) + 1);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function toStored(
  credential: ProviderCredential,
  now: number,
): StoredProviderCredential {
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    ...(credential.idToken && { idToken: credential.idToken }),
    ...(credential.expiresAt && { expiresAt: credential.expiresAt }),
    ...(credential.accountId && { accountId: credential.accountId }),
    obtainedAt: new Date(now).toISOString(),
  };
}

function toCredential(stored: StoredProviderCredential): ProviderCredential {
  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    ...(stored.idToken && { idToken: stored.idToken }),
    ...(stored.expiresAt && { expiresAt: stored.expiresAt }),
    ...(stored.accountId && { accountId: stored.accountId }),
  };
}
