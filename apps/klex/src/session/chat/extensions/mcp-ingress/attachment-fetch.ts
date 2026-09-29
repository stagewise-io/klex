import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
export const ATTACHMENT_TIMEOUT_MS = 10_000;

export type AttachmentErrorCode =
  | 'invalid-input'
  | 'unauthorized'
  | 'ssrf-rejected'
  | 'fetch-failed'
  | 'too-large'
  | 'timeout'
  | 'unsupported-media'
  | 'unsupported-provider'
  | 'conversion-failed'
  | 'provider-error';

export class AttachmentError extends Error {
  constructor(readonly code: AttachmentErrorCode) {
    super(code);
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
// Permit only ordinary IPv6 global unicast; exclude transition, documentation,
// benchmarking and special-purpose ranges (including IPv4 translation).
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAttachmentAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return (
    family === 6 &&
    globalV6.check(address, 'ipv6') &&
    !blocked.check(address, 'ipv6')
  );
}

export function parseAttachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AttachmentError('invalid-input');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new AttachmentError('ssrf-rejected');
  return url;
}

/** No proxy, cookies, authorization headers, redirects, decompression or disk. */
export async function fetchAttachment(
  url: URL,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAttachmentAddress(address))
  ) {
    throw new AttachmentError('ssrf-rejected');
  }
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        agent: false,
        signal,
        // Connect only to the checked address. TLS still verifies the original
        // hostname. Never perform another DNS lookup after validation.
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [
                { address: pinned.address, family: pinned.family },
              ])
            : callback(null, pinned.address, pinned.family),
        headers: {
          Accept: 'image/png, image/jpeg, image/webp',
          'Accept-Encoding': 'identity',
        },
      },
      (response) => {
        const fail = (code: AttachmentErrorCode) => {
          reject(new AttachmentError(code));
          response.destroy();
          req.destroy();
        };
        if (response.statusCode !== 200) {
          fail('fetch-failed');
          return;
        }
        if (
          response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity'
        ) {
          fail('unsupported-media');
          return;
        }
        const length = response.headers['content-length'];
        if (
          length &&
          (!/^\d+$/.test(length) || Number(length) > ATTACHMENT_MAX_BYTES)
        ) {
          fail('too-large');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > ATTACHMENT_MAX_BYTES) {
            fail('too-large');
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new AttachmentError('fetch-failed')));
        response.on('end', () =>
          resolve({
            bytes: Buffer.concat(chunks),
            mimeType: (response.headers['content-type'] ?? '')
              .split(';')[0]!
              .trim()
              .toLowerCase(),
          }),
        );
      },
    );
    req.on('error', () =>
      reject(new AttachmentError(signal.aborted ? 'timeout' : 'fetch-failed')),
    );
    req.end();
  });
}
