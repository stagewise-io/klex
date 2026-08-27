import { createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportJWK } from 'jose';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  importPrivateKey,
  loadOrCreateIdentity,
  publicKeyToJwks,
} from './identity';

const logging = createLogger({ name: 'klex', type: 'hidden' });

const directories: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klex-identity-test-'));
  directories.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    directories.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('identity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('loadOrCreateIdentity', () => {
    it('generates new keypair when none exists', async () => {
      const identity = await loadOrCreateIdentity(dir, logging);

      expect(identity.algorithm).toBe('EdDSA');
      expect(identity.kid).toMatch(/^klex-key-/);
      expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY');

      // Files created
      const keyContent = await readFile(
        join(dir, 'identity', 'private-key.pem'),
        'utf8',
      );
      expect(keyContent).toBe(identity.privateKeyPem);

      const metadataContent = await readFile(
        join(dir, 'identity', 'metadata.json'),
        'utf8',
      );
      const metadata = JSON.parse(metadataContent);
      expect(metadata.kid).toBe(identity.kid);
      expect(metadata.algorithm).toBe('EdDSA');
    });

    it('private key file has 0600 permissions', async () => {
      await loadOrCreateIdentity(dir, logging);

      const stats = await stat(join(dir, 'identity', 'private-key.pem'));
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('reloads existing keypair on second call', async () => {
      const first = await loadOrCreateIdentity(dir, logging);
      const second = await loadOrCreateIdentity(dir, logging);

      expect(second.privateKeyPem).toBe(first.privateKeyPem);
      expect(second.kid).toBe(first.kid);
      expect(second.algorithm).toBe(first.algorithm);
    });

    it('generates different keys for different directories', async () => {
      const dir2 = await makeTempDir();

      const identity1 = await loadOrCreateIdentity(dir, logging);
      const identity2 = await loadOrCreateIdentity(dir2, logging);

      expect(identity1.privateKeyPem).not.toBe(identity2.privateKeyPem);
      expect(identity1.kid).not.toBe(identity2.kid);
    });

    it('never regenerates keypair when private key file exists', async () => {
      // Create identity once
      const first = await loadOrCreateIdentity(dir, logging);

      // Delete metadata.json — key file still present
      await rm(join(dir, 'identity', 'metadata.json')).catch(() => undefined);

      // Load again — key must be identical, metadata regenerated
      const second = await loadOrCreateIdentity(dir, logging);

      expect(second.privateKeyPem).toBe(first.privateKeyPem);
      // New metadata means new kid (enrollment will be stale)
      expect(second.kid).not.toBe(first.kid);
      expect(second.algorithm).toBe(first.algorithm);
    });

    it('generates new keypair when neither file exists', async () => {
      const first = await loadOrCreateIdentity(dir, logging);

      // Delete both files
      await rm(join(dir, 'identity', 'private-key.pem')).catch(() => undefined);
      await rm(join(dir, 'identity', 'metadata.json')).catch(() => undefined);

      const second = await loadOrCreateIdentity(dir, logging);

      expect(second.privateKeyPem).not.toBe(first.privateKeyPem);
      expect(second.kid).not.toBe(first.kid);
    });

    it('does not regenerate keypair when metadata references different kid', async () => {
      const first = await loadOrCreateIdentity(dir, logging);

      // Overwrite metadata with a different kid
      await writeFile(
        join(dir, 'identity', 'metadata.json'),
        JSON.stringify({
          kid: 'klex-key-different-kid',
          algorithm: 'EdDSA',
          createdAt: new Date().toISOString(),
        }),
        'utf8',
      );

      const second = await loadOrCreateIdentity(dir, logging);

      // Key file untouched — same private key
      expect(second.privateKeyPem).toBe(first.privateKeyPem);
      // Metadata loaded as-is — different kid
      expect(second.kid).toBe('klex-key-different-kid');
    });
  });

  describe('publicKeyToJwks', () => {
    it('produces valid OKP JWK with Ed25519 curve', async () => {
      const identity = await loadOrCreateIdentity(dir, logging);
      const jwks = await publicKeyToJwks(identity);

      expect(jwks.keys).toHaveLength(1);
      const jwk = jwks.keys[0] as Record<string, string>;
      expect(jwk.kty).toBe('OKP');
      expect(jwk.crv).toBe('Ed25519');
      expect(jwk.kid).toBe(identity.kid);
      expect(jwk.use).toBe('sig');
      expect(jwk.x).toBeTypeOf('string');
      expect(jwk.x?.length).toBeGreaterThan(0);
    });

    it('does not contain private key material (no d parameter)', async () => {
      const identity = await loadOrCreateIdentity(dir, logging);
      const jwks = await publicKeyToJwks(identity);

      const jwk = jwks.keys[0] as Record<string, string>;
      expect(jwk.d).toBeUndefined();
    });

    it('JWK matches the public key derived from the private key', async () => {
      const identity = await loadOrCreateIdentity(dir, logging);
      const jwks = await publicKeyToJwks(identity);

      // Also export JWK directly from the public key via jose
      const pubKey = createPublicKey(identity.privateKeyPem);
      const directJwk = await exportJWK(pubKey);

      const jwk = jwks.keys[0] as Record<string, string>;
      expect(jwk.x).toBe(directJwk.x);
      expect(jwk.kty).toBe(directJwk.kty);
      expect(jwk.crv).toBe(directJwk.crv);
    });
  });

  describe('importPrivateKey', () => {
    it('returns a usable CryptoKey', async () => {
      const identity = await loadOrCreateIdentity(dir, logging);
      const cryptoKey = await importPrivateKey(identity);

      expect(cryptoKey).toBeInstanceOf(CryptoKey);
      expect(cryptoKey.type).toBe('private');
      expect(cryptoKey.extractable).toBe(false);
      // Ed25519 keys have usages set
      expect(cryptoKey.usages).toContain('sign');
    });
  });
});
