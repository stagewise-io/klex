import { createHash, createPublicKey, verify } from 'node:crypto';

/** DER prefix that turns a raw 32-byte Ed25519 key into an SPKI key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TRUSTED_COMMENT = 'trusted comment: ';

/**
 * Verifies a Tauri updater signature: a base64-encoded minisign signature
 * file, checked against a base64-encoded minisign public key file. Returns
 * the trusted comment, which the signature covers.
 */
export function verifyUpdaterSignature(
  publicKey: string,
  signature: string,
  data: Buffer,
): string {
  const key = decodeLines(publicKey);
  const keyBytes = Buffer.from(requiredLine(key, 1, 'public key'), 'base64');
  if (keyBytes.length !== 42 || keyBytes.subarray(0, 2).toString() !== 'Ed') {
    throw new Error('The updater public key is not a minisign Ed25519 key');
  }
  const signatureFile = decodeLines(signature);
  const signatureBytes = Buffer.from(
    requiredLine(signatureFile, 1, 'signature'),
    'base64',
  );
  const trustedLine = requiredLine(signatureFile, 2, 'trusted comment');
  const globalSignature = Buffer.from(
    requiredLine(signatureFile, 3, 'global signature'),
    'base64',
  );
  if (
    signatureBytes.length !== 74 ||
    !trustedLine.startsWith(TRUSTED_COMMENT)
  ) {
    throw new Error('The updater signature is not a minisign signature');
  }
  const algorithm = signatureBytes.subarray(0, 2).toString();
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(`Unsupported minisign algorithm ${algorithm}`);
  }
  if (!signatureBytes.subarray(2, 10).equals(keyBytes.subarray(2, 10))) {
    throw new Error('The updater signature was made with a different key');
  }
  const ed25519 = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const message =
    algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const rawSignature = signatureBytes.subarray(10);
  if (!verify(null, message, ed25519, rawSignature)) {
    throw new Error('The updater signature does not match the file');
  }
  const trustedComment = trustedLine.slice(TRUSTED_COMMENT.length);
  const signed = Buffer.concat([rawSignature, Buffer.from(trustedComment)]);
  if (!verify(null, signed, ed25519, globalSignature)) {
    throw new Error('The updater signature has a tampered trusted comment');
  }
  return trustedComment;
}

/** `version` field of a trusted comment the Tauri CLI wrote. */
export function signedVersion(trustedComment: string): string | undefined {
  return trustedComment
    .split('\t')
    .find((field) => field.startsWith('version:'))
    ?.slice('version:'.length);
}

function decodeLines(base64: string): string[] {
  return Buffer.from(base64.trim(), 'base64')
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function requiredLine(lines: string[], index: number, name: string): string {
  const line = lines[index];
  if (line === undefined) throw new Error(`Missing minisign ${name}`);
  return line;
}
