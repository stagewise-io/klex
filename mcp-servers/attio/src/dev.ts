import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeyWrapper } from './credentials.js';
import type {
  Attempt,
  Connection,
  ConnectionStore,
  Principal,
} from './store.js';

/** Test/dev only: process-local, no disk writes or restart durability. */
export class MemoryConnectionStore implements ConnectionStore {
  private readonly connections = new Map<string, Connection>();
  private readonly attempts = new Map<string, Attempt>();
  private key(tenant: string, id: string) {
    return JSON.stringify([tenant, id]);
  }
  async create(connection: Connection) {
    const key = this.key(connection.tenantId, connection.id);
    if (this.connections.has(key)) return false;
    this.connections.set(key, structuredClone(connection));
    return true;
  }
  async get(tenantId: string, id: string) {
    return structuredClone(this.connections.get(this.key(tenantId, id)));
  }
  async compareAndSet(next: Connection, expected: number) {
    const key = this.key(next.tenantId, next.id);
    if (
      this.connections.get(key)?.generation !== expected ||
      next.generation !== expected + 1
    )
      return false;
    this.connections.set(key, structuredClone(next));
    return true;
  }
  async putAttempt(attempt: Attempt) {
    for (const [key, old] of this.attempts) {
      if (
        old.expiresAt <= attempt.expiresAt - 600_000 ||
        (old.tenantId === attempt.tenantId &&
          old.connectionId === attempt.connectionId)
      )
        this.attempts.delete(key);
    }
    this.attempts.set(attempt.stateHash, structuredClone(attempt));
  }
  async consumeAttempt(
    hash: string,
    principal: Principal,
    sessionHash: string,
    now: number,
  ) {
    const attempt = this.attempts.get(hash);
    if (
      !attempt ||
      attempt.tenantId !== principal.tenantId ||
      attempt.principalId !== principal.principalId ||
      attempt.sessionHash !== sessionHash
    )
      return;
    this.attempts.delete(hash);
    return attempt.expiresAt > now ? structuredClone(attempt) : undefined;
  }
}

/** Local wrapping key is supplied separately, never serialized in the store.
 * Retain old versions during rotation. This is not a production KMS adapter.
 */
export class LocalKeyWrapper implements KeyWrapper {
  constructor(
    private readonly keys: ReadonlyMap<string, Uint8Array>,
    private readonly activeVersion: string,
  ) {}
  async wrap(key: Uint8Array) {
    const master = this.keys.get(this.activeVersion);
    if (master?.length !== 32) throw new Error('Key unavailable');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', master, nonce);
    cipher.setAAD(Buffer.from(this.activeVersion));
    const body = Buffer.concat([cipher.update(key), cipher.final()]);
    return {
      keyVersion: this.activeVersion,
      wrappedKey: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString(
        'base64',
      ),
    };
  }
  async unwrap(wrappedKey: string, version: string) {
    const master = this.keys.get(version);
    if (!master) throw new Error('Key unavailable');
    const bytes = Buffer.from(wrappedKey, 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      master,
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(version));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
  }
}
