import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
}

export interface MachineIdentity {
  privateKey: CryptoKey;
  privateKeyKid: string;
  publicJwk: PublicJwk;
}

function toPem(bytes: ArrayBuffer): string {
  const body = Buffer.from(bytes)
    .toString('base64')
    .match(/.{1,64}/g)
    ?.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

function fromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  if (!body) throw new Error('Machine private key is corrupt');
  return Uint8Array.from(Buffer.from(body, 'base64'));
}

async function identityFromPrivateKey(
  privateKey: CryptoKey,
): Promise<MachineIdentity> {
  const privateJwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (!privateJwk.kty || !privateJwk.crv || !privateJwk.x) {
    throw new Error('Ed25519 key export is incomplete');
  }
  const publicJwk: PublicJwk = {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    kid: '',
    alg: 'EdDSA',
    use: 'sig',
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `${publicJwk.kty}:${publicJwk.crv}:${publicJwk.x}`,
    ),
  );
  const privateKeyKid = Buffer.from(digest).toString('base64url');
  publicJwk.kid = privateKeyKid;
  return { privateKey, privateKeyKid, publicJwk };
}

export async function generateMachineIdentity(): Promise<MachineIdentity> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  return identityFromPrivateKey(pair.privateKey);
}

export async function saveMachineIdentity(
  path: string,
  identity: MachineIdentity,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (
    await access(path, constants.F_OK).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(
      `Refusing to replace existing machine private key: ${path}`,
    );
  }
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', identity.privateKey);
  await writeFile(path, toPem(pkcs8), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

export async function loadMachineIdentity(
  path: string,
): Promise<MachineIdentity> {
  const pem = await readFile(path, 'utf8');
  try {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      fromPem(pem),
      'Ed25519',
      true,
      ['sign'],
    );
    return identityFromPrivateKey(privateKey);
  } catch (error) {
    throw new Error(`Machine private key is corrupt: ${path}`, {
      cause: error,
    });
  }
}
