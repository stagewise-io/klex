import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  DeviceAuthorizationPollResult,
  ProviderAuthorization,
  ProviderCredential,
  ProviderInstance,
  ProviderOperationResult,
} from '../provider-registry';
import {
  ProviderCredentialError,
  ProviderCredentialManager,
  type ProviderHookRunner,
} from './credential-manager';
import { ProviderCredentialStore } from './credential-store';
import { DeviceAuthorizations } from './device-authorizations';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as ModuleLogger;

const runHook: ProviderHookRunner = async (operation) =>
  (await operation(new AbortController().signal)) ?? {
    ok: false,
    code: 'internal_error',
    message: 'missing result',
  };

const instance: ProviderInstance = {
  id: 'codex',
  type: 'chatgpt-codex-subscription',
  settings: { authMode: 'managed' },
};

const ok = <T>(value: T): ProviderOperationResult<T> => ({
  ok: true,
  code: 'available',
  value,
});

function credential(
  accessToken: string,
  expiresAt?: number,
): ProviderCredential {
  return {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    accountId: 'acct',
    ...(expiresAt !== undefined && {
      expiresAt: new Date(expiresAt).toISOString(),
    }),
  };
}

function authorization(
  overrides: Partial<ProviderAuthorization> = {},
): ProviderAuthorization {
  return {
    method: 'device-code',
    isRequired: () => true,
    start: vi.fn(async () =>
      ok({
        verificationUri: 'https://auth.example/device',
        userCode: 'SECRET-CODE',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        intervalMs: 1,
        handle: { device: 'd' },
      }),
    ),
    poll: vi.fn(async () =>
      ok<DeviceAuthorizationPollResult>({ status: 'pending' }),
    ),
    refresh: vi.fn(async () => ok(credential('refreshed'))),
    ...overrides,
  };
}

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'klex-provider-auth-'));
  filePath = join(directory, 'credentials', 'providers.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('ProviderCredentialStore', () => {
  it('round-trips records with owner-only permissions', async () => {
    const store = new ProviderCredentialStore(filePath);
    expect(await store.load()).toEqual({});
    await store.save('codex', 'chatgpt-codex-subscription', {
      accessToken: 'a',
      refreshToken: 'r',
      obtainedAt: '2026-01-01T00:00:00.000Z',
    });
    const reopened = new ProviderCredentialStore(filePath);
    expect(await reopened.get('codex')).toMatchObject({
      status: 'authorized',
      credential: { accessToken: 'a', refreshToken: 'r' },
    });
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'credentials'))).mode & 0o777).toBe(
        0o700,
      );
    }
  });

  it('preserves unknown fields and serializes concurrent writes', async () => {
    const store = new ProviderCredentialStore(filePath);
    await store.save('a', 't', {
      accessToken: 'a',
      refreshToken: 'r',
      obtainedAt: 'x',
    });
    const document = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      filePath,
      JSON.stringify({ ...document, future: { kept: true } }),
    );
    await Promise.all(
      ['b', 'c', 'd'].map((id) =>
        store.save(id, 't', {
          accessToken: id,
          refreshToken: 'r',
          obtainedAt: 'x',
        }),
      ),
    );
    expect(Object.keys(await store.load()).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(JSON.parse(await readFile(filePath, 'utf8')).future).toEqual({
      kept: true,
    });
    expect(await store.delete('a')).toBe(true);
    expect(await store.delete('a')).toBe(false);
  });
});

describe('ProviderCredentialManager', () => {
  it('returns a fresh credential without refreshing', async () => {
    const auth = authorization();
    const manager = new ProviderCredentialManager({ runHook, logger });
    await manager.save(instance, credential('fresh', Date.now() + 3_600_000));
    const value = await manager.contextFor(instance, auth).credential();
    expect(value?.accessToken).toBe('fresh');
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('refreshes exactly once for concurrent callers near expiry', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = authorization({
      refresh: vi.fn(async () => {
        await gate;
        return ok(credential('rotated', Date.now() + 3_600_000));
      }),
    });
    const store = new ProviderCredentialStore(filePath);
    const manager = new ProviderCredentialManager({ store, runHook, logger });
    await manager.save(instance, credential('stale', Date.now() + 60_000));
    const context = manager.contextFor(instance, auth);
    const calls = Promise.all([
      context.credential(),
      context.credential(),
      context.invalidate(),
    ]);
    release();
    const results = await calls;
    expect(results.map((item) => item?.accessToken)).toEqual([
      'rotated',
      'rotated',
      'rotated',
    ]);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect((await store.get('codex'))?.credential?.accessToken).toBe('rotated');
  });

  it('revokes on a permanent refresh failure', async () => {
    const auth = authorization({
      refresh: vi.fn(async () => ({
        ok: false as const,
        code: 'authentication_required' as const,
        message: 'Sign in again',
      })),
    });
    const store = new ProviderCredentialStore(filePath);
    const manager = new ProviderCredentialManager({ store, runHook, logger });
    await manager.save(instance, credential('stale', Date.now() - 1));
    expect(await manager.contextFor(instance, auth).credential()).toBe(
      undefined,
    );
    expect(manager.record('codex')?.status).toBe('revoked');
    const stored = await store.get('codex');
    expect(stored?.status).toBe('revoked');
    expect(stored?.credential).toBeUndefined();
  });

  it('keeps the credential on a transient refresh failure', async () => {
    const auth = authorization({
      refresh: vi.fn(async () => ({
        ok: false as const,
        code: 'connectivity_failed' as const,
        message: 'Provider returned HTTP 503',
      })),
    });
    const manager = new ProviderCredentialManager({ runHook, logger });
    await manager.save(instance, credential('stale', Date.now() - 1));
    await expect(
      manager.contextFor(instance, auth).credential(),
    ).rejects.toBeInstanceOf(ProviderCredentialError);
    expect(manager.record('codex')?.status).toBe('authorized');
  });

  it('restores persisted credentials after a restart', async () => {
    const store = new ProviderCredentialStore(filePath);
    const first = new ProviderCredentialManager({ store, runHook, logger });
    await first.save(instance, credential('kept', Date.now() + 3_600_000));
    const second = new ProviderCredentialManager({
      store: new ProviderCredentialStore(filePath),
      runHook,
      logger,
    });
    await second.load();
    expect(
      (await second.contextFor(instance, authorization()).credential())
        ?.accessToken,
    ).toBe('kept');
  });

  it('isolates credentials per instance and deletes them', async () => {
    const manager = new ProviderCredentialManager({ runHook, logger });
    await manager.save(instance, credential('one', Date.now() + 3_600_000));
    const other = { ...instance, id: 'other' };
    expect(
      await manager.contextFor(other, authorization()).credential(),
    ).toBeUndefined();
    expect(await manager.delete('codex')).toBe(true);
    expect(
      await manager.contextFor(instance, authorization()).credential(),
    ).toBeUndefined();
  });

  it('lets a sign-out during an in-flight sign-in write win', async () => {
    const store = new ProviderCredentialStore(filePath);
    const manager = new ProviderCredentialManager({ store, runHook, logger });
    const saving = manager.save(instance, credential('late'));
    await manager.delete('codex');
    await saving;
    expect(manager.record('codex')).toBeUndefined();
    expect(await store.get('codex')).toBeUndefined();
    const restarted = new ProviderCredentialManager({
      store: new ProviderCredentialStore(filePath),
      runHook,
      logger,
    });
    await restarted.load();
    expect(restarted.record('codex')).toBeUndefined();
  });

  it('discards a refresh that finishes after sign-out', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = authorization({
      refresh: vi.fn(async () => {
        await gate;
        return ok(credential('rotated', Date.now() + 3_600_000));
      }),
    });
    const store = new ProviderCredentialStore(filePath);
    const manager = new ProviderCredentialManager({ store, runHook, logger });
    await manager.save(instance, credential('stale', Date.now() + 60_000));
    const refreshing = manager.contextFor(instance, auth).credential();
    await vi.waitFor(() => expect(auth.refresh).toHaveBeenCalled());
    await manager.delete('codex');
    release();
    expect(await refreshing).toBeUndefined();
    expect(manager.record('codex')).toBeUndefined();
    expect(await store.get('codex')).toBeUndefined();
  });
});

describe('DeviceAuthorizations', () => {
  function setup(auth: ProviderAuthorization, now?: () => number) {
    const credentials = new ProviderCredentialManager({
      store: new ProviderCredentialStore(filePath),
      runHook,
      logger,
    });
    const onAuthorized = vi.fn();
    const devices = new DeviceAuthorizations({
      runHook,
      credentials,
      logger,
      onAuthorized,
      ...(now && { now }),
    });
    return { credentials, devices, onAuthorized };
  }

  it('is idempotent while pending and cancels cleanly', async () => {
    const auth = authorization();
    const { devices } = setup(auth);
    const [first, second] = await Promise.all([
      devices.start(instance, auth),
      devices.start(instance, auth),
    ]);
    const third = await devices.start(instance, auth);
    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(auth.start).toHaveBeenCalledTimes(1);
    expect(devices.status('codex')?.state).toBe('pending');
    expect(devices.cancel('codex')).toBe(true);
    expect(devices.status('codex')).toBeUndefined();
  });

  it('stores the credential when the poll succeeds', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(ok({ status: 'pending' }))
      .mockResolvedValueOnce(
        ok({ status: 'authorized', credential: credential('granted') }),
      );
    const auth = authorization({ poll });
    const { credentials, devices, onAuthorized } = setup(auth);
    await devices.start(instance, auth);
    await vi.waitFor(() => expect(onAuthorized).toHaveBeenCalledWith('codex'));
    expect(poll).toHaveBeenCalledTimes(2);
    expect(credentials.record('codex')?.credential?.accessToken).toBe(
      'granted',
    );
    expect(devices.status('codex')).toBeUndefined();
  });

  // Mirrors the registry's sign-out: cancel the attempt, then delete.
  async function signOut(
    devices: DeviceAuthorizations,
    credentials: ProviderCredentialManager,
  ): Promise<void> {
    devices.cancel('codex');
    await credentials.delete('codex');
  }

  it('drops a grant whose poll finishes after sign-out', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const poll = vi.fn(async () => {
      await gate;
      return ok<DeviceAuthorizationPollResult>({
        status: 'authorized',
        credential: credential('late'),
      });
    });
    const auth = authorization({ poll });
    const { credentials, devices, onAuthorized } = setup(auth);
    await devices.start(instance, auth);
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    await signOut(devices, credentials);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(credentials.record('codex')).toBeUndefined();
    expect(
      await new ProviderCredentialStore(filePath).get('codex'),
    ).toBeUndefined();
  });

  it('drops a grant when sign-out lands during its credential write', async () => {
    const auth = authorization({
      poll: vi.fn(async () =>
        ok<DeviceAuthorizationPollResult>({
          status: 'authorized',
          credential: credential('late'),
        }),
      ),
    });
    const { credentials, devices, onAuthorized } = setup(auth);
    const save = credentials.save.bind(credentials);
    let signedOut: Promise<void> | undefined;
    vi.spyOn(credentials, 'save').mockImplementation(async (...args) => {
      const writing = save(...args);
      signedOut = signOut(devices, credentials);
      await writing;
    });
    await devices.start(instance, auth);
    await vi.waitFor(() => expect(signedOut).toBeDefined());
    await signedOut;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(credentials.record('codex')).toBeUndefined();
    expect(
      await new ProviderCredentialStore(filePath).get('codex'),
    ).toBeUndefined();
  });

  it('reports a denied sign-in as failed', async () => {
    const auth = authorization({
      poll: vi.fn(async () => ({
        ok: false as const,
        code: 'authentication_required' as const,
        message: 'Sign-in was denied',
      })),
    });
    const { devices } = setup(auth);
    await devices.start(instance, auth);
    await vi.waitFor(() =>
      expect(devices.status('codex')).toMatchObject({
        state: 'failed',
        message: 'Sign-in was denied',
      }),
    );
  });

  it('reports an expired attempt', async () => {
    let now = Date.now();
    const auth = authorization();
    const { devices } = setup(auth, () => now);
    await devices.start(instance, auth);
    now += 120_000;
    expect(devices.status('codex')?.state).toBe('expired');
  });

  it('does not expose the user code in status', async () => {
    const auth = authorization();
    const { devices } = setup(auth);
    await devices.start(instance, auth);
    expect(JSON.stringify(devices.status('codex'))).not.toContain(
      'SECRET-CODE',
    );
    devices.close();
  });
});
