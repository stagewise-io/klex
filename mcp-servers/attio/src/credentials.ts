import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AttioError } from './errors.js';

export interface KeyWrapper {
  wrap(key: Uint8Array): Promise<{ wrappedKey: string; keyVersion: string }>;
  unwrap(wrappedKey: string, keyVersion: string): Promise<Uint8Array>;
}
export interface Envelope {
  version: 1;
  ciphertext: string;
  nonce: string;
  tag: string;
  wrappedKey: string;
  keyVersion: string;
}
export interface CredentialContext {
  tenantId: string;
  connectionId: string;
  purpose: 'client-secret' | 'access-token';
}
const aad = (context: CredentialContext) =>
  Buffer.from(
    JSON.stringify([
      1,
      context.tenantId,
      context.connectionId,
      context.purpose,
    ]),
  );
export class CredentialCipher {
  constructor(private readonly keys: KeyWrapper) {}
  async seal(secret: string, context: CredentialContext): Promise<Envelope> {
    const key = randomBytes(32);
    try {
      const wrapped = await this.keys.wrap(key);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([
        cipher.update(secret, 'utf8'),
        cipher.final(),
      ]);
      return {
        version: 1,
        ...wrapped,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } catch {
      throw new AttioError('UNAVAILABLE');
    } finally {
      key.fill(0);
    }
  }
  async open(envelope: Envelope, context: CredentialContext): Promise<string> {
    let key: Uint8Array | undefined;
    try {
      if (envelope.version !== 1) throw new Error();
      key = await this.keys.unwrap(envelope.wrappedKey, envelope.keyVersion);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.nonce, 'base64'),
      );
      decipher.setAAD(aad(context));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new AttioError('UNAVAILABLE');
    } finally {
      key?.fill(0);
    }
  }
}
