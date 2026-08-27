import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { exportJWK, importPKCS8 } from 'jose';

import type { ModuleLogger } from '@stagewise/logger';

import { IDENTITY_DIR, writeSecureJsonFile } from './storage';
import type { CloudAlgorithm, CloudIdentity } from './types';

const PRIVATE_KEY_FILE = 'private-key.pem';
const METADATA_FILE = 'metadata.json';
const KEY_ALGORITHM: CloudAlgorithm = 'EdDSA';

interface IdentityMetadata {
  kid: string;
  algorithm: CloudAlgorithm;
  createdAt: string;
}

function createMetadata(): IdentityMetadata {
  return {
    kid: `klex-key-${randomUUID()}`,
    algorithm: KEY_ALGORITHM,
    createdAt: new Date().toISOString(),
  };
}

export async function loadOrCreateIdentity(
  dataDirectory: string,
  logger: ModuleLogger,
): Promise<CloudIdentity> {
  const identityDir = join(dataDirectory, IDENTITY_DIR);
  await mkdir(identityDir, { recursive: true });

  const keyPath = join(identityDir, PRIVATE_KEY_FILE);
  const metadataPath = join(identityDir, METADATA_FILE);

  // Try loading existing private key first.
  // If a key exists in the directory, we MUST NOT regenerate it.
  let privateKeyPem: string | null = null;
  try {
    privateKeyPem = await readFile(keyPath, 'utf8');
  } catch {
    // Key file missing — will generate below
  }

  if (privateKeyPem === null) {
    // No private key file — generate a new keypair with matching metadata.
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    privateKeyPem = privateKey;

    const metadata = createMetadata();

    await writeFile(keyPath, privateKeyPem, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await writeSecureJsonFile(metadataPath, metadata);

    logger.info(
      { kid: metadata.kid },
      'Generated new Ed25519 identity keypair',
    );

    return {
      privateKeyPem,
      kid: metadata.kid,
      algorithm: metadata.algorithm,
    };
  }

  // Private key exists — load or regenerate metadata, but NEVER touch the key.
  let metadata: IdentityMetadata;
  try {
    const raw = await readFile(metadataPath, 'utf8');
    metadata = JSON.parse(raw) as IdentityMetadata;
  } catch {
    // Metadata missing but key exists — generate new metadata for the
    // existing key.  This produces a new kid, which means any prior
    // enrollment will be treated as stale (kid mismatch) and the agent
    // will need to re-enroll.
    metadata = createMetadata();
    await writeSecureJsonFile(metadataPath, metadata);
    logger.warn(
      { kid: metadata.kid },
      'Identity metadata missing — generated new metadata for existing private key',
    );
  }

  return {
    privateKeyPem,
    kid: metadata.kid,
    algorithm: metadata.algorithm,
  };
}

export async function publicKeyToJwks(
  identity: CloudIdentity,
): Promise<{ keys: object[] }> {
  const pubKey = createPublicKey(identity.privateKeyPem);
  const jwk = await exportJWK(pubKey);
  jwk.kid = identity.kid;
  jwk.use = 'sig';
  return { keys: [jwk] };
}

export async function importPrivateKey(
  identity: CloudIdentity,
): Promise<CryptoKey> {
  return importPKCS8(identity.privateKeyPem, identity.algorithm);
}
