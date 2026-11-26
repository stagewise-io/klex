import { constants, deflateSync, inflateSync } from 'node:zlib';

/** Extended Clipboard pseudo-encoding (0xC0A1E5CE). */
export const EXTENDED_CLIPBOARD = 0xc0a1e5ce | 0;

export const CLIPBOARD_TEXT = 1;
export const CLIPBOARD_CAPS = 1 << 24;
export const CLIPBOARD_REQUEST = 1 << 25;
export const CLIPBOARD_PEEK = 1 << 26;
export const CLIPBOARD_NOTIFY = 1 << 27;
export const CLIPBOARD_PROVIDE = 1 << 28;
const ACTIONS = 0xff000000;
const FORMATS = 0x0000ffff;

/** Largest clipboard text accepted or offered, in UTF-8 bytes. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

const SERVER_CUT_TEXT = 3;

export type ClipboardMessage =
  | { action: 'caps'; formats: number }
  | { action: 'request' | 'peek' | 'notify'; formats: number }
  | { action: 'provide'; text: string | undefined }
  | { action: 'unknown' };

/** ServerCutText carrying an extended clipboard payload. */
function serverCutText(payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = SERVER_CUT_TEXT;
  header.writeInt32BE(-payload.length, 4);
  return Buffer.concat([header, payload]);
}

function flags(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

/** The server's capabilities: UTF-8 text with request, notify and provide. */
export function clipboardCaps(): Buffer {
  const sizes = Buffer.alloc(4);
  sizes.writeUInt32BE(MAX_CLIPBOARD_BYTES, 0);
  return serverCutText(
    Buffer.concat([
      flags(
        CLIPBOARD_CAPS |
          CLIPBOARD_REQUEST |
          CLIPBOARD_PEEK |
          CLIPBOARD_NOTIFY |
          CLIPBOARD_PROVIDE |
          CLIPBOARD_TEXT,
      ),
      sizes,
    ]),
  );
}

export function clipboardNotify(hasText: boolean): Buffer {
  return serverCutText(
    flags(CLIPBOARD_NOTIFY | (hasText ? CLIPBOARD_TEXT : 0)),
  );
}

export function clipboardRequest(): Buffer {
  return serverCutText(flags(CLIPBOARD_REQUEST | CLIPBOARD_TEXT));
}

/** Text as the protocol wants it: UTF-8, CRLF line ends, NUL-terminated. */
export function clipboardProvide(text: string): Buffer {
  const encoded = Buffer.from(
    `${text.replace(/\r\n|\r|\n/g, '\r\n')}\0`,
    'utf8',
  );
  const size = Buffer.alloc(4);
  size.writeUInt32BE(encoded.length, 0);
  return serverCutText(
    Buffer.concat([
      flags(CLIPBOARD_PROVIDE | CLIPBOARD_TEXT),
      deflateSync(Buffer.concat([size, encoded])),
    ]),
  );
}

/** Legacy ServerCutText: Latin-1 only. */
export function legacyCutText(text: string): Buffer {
  const header = Buffer.alloc(8);
  header[0] = SERVER_CUT_TEXT;
  const body = Buffer.from(
    [...text.replace(/\r\n|\r/g, '\n')]
      .map((char) => {
        const code = char.codePointAt(0) as number;
        return code <= 0xff ? char : '?';
      })
      .join(''),
    'latin1',
  );
  header.writeInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Text from a legacy ClientCutText, which is Latin-1. */
export function decodeLegacyCutText(data: Buffer): string {
  return normalize(data.toString('latin1'));
}

/** Parses the payload of a ClientCutText with a negative length. */
export function parseClipboardMessage(payload: Buffer): ClipboardMessage {
  if (payload.length < 4) return { action: 'unknown' };
  const value = payload.readUInt32BE(0);
  const actions = value & ACTIONS;
  const formats = value & FORMATS;
  if (actions & CLIPBOARD_CAPS) return { action: 'caps', formats };
  switch (actions >>> 0) {
    case CLIPBOARD_REQUEST:
      return { action: 'request', formats };
    case CLIPBOARD_PEEK:
      return { action: 'peek', formats };
    case CLIPBOARD_NOTIFY:
      return { action: 'notify', formats };
    case CLIPBOARD_PROVIDE:
      return { action: 'provide', text: readProvidedText(payload, formats) };
    default:
      return { action: 'unknown' };
  }
}

function readProvidedText(
  payload: Buffer,
  formats: number,
): string | undefined {
  if (!(formats & CLIPBOARD_TEXT)) return undefined;
  let data: Buffer;
  try {
    // Viewers flush rather than finish the stream, so it has no end marker.
    data = inflateSync(payload.subarray(4), {
      finishFlush: constants.Z_SYNC_FLUSH,
      maxOutputLength: MAX_CLIPBOARD_BYTES + 4,
    });
  } catch {
    return undefined;
  }
  // Formats follow in bit order; text is the lowest, so it comes first.
  if (data.length < 4) return undefined;
  const size = data.readUInt32BE(0);
  if (size > MAX_CLIPBOARD_BYTES || data.length < 4 + size) return undefined;
  return normalize(data.subarray(4, 4 + size).toString('utf8'));
}

function normalize(text: string): string {
  return text.replace(/\0+$/, '').replace(/\r\n?/g, '\n');
}
