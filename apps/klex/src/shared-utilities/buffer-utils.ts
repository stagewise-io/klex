/** Converts a DataContent value (string, Uint8Array, ArrayBuffer, or unknown) to a Buffer. */
export function dataContentToBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Uint8Array);
}

/** Parses a `data:` URL and returns the decoded buffer, or null for remote URLs. */
export function extractBufferFromUrl(url: URL): Buffer | null {
  if (url.protocol !== 'data:') return null; // Remote URL — pass through
  const str = url.toString();
  const comma = str.indexOf(',');
  if (comma === -1) return null;
  const meta = str.slice(5, comma); // Remove "data:" prefix
  const payload = str.slice(comma + 1);
  if (!meta.includes('base64')) return null;
  return Buffer.from(payload, 'base64');
}
