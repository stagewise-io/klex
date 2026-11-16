export class RfbProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RfbProtocolError';
  }
}

const SECURITY_NONE = 1;
/** Larger client messages are refused instead of buffered without bound. */
export const MAX_RFB_CLIENT_MESSAGE_BYTES = 1024 * 1024;

type Phase = 'version' | 'security' | 'init' | 'messages';

/**
 * Parses the client-to-server half of an RFB 3.3/3.7/3.8 session and drops
 * input (keys, pointer, clipboard, resize) unless input is allowed. Messages
 * are reassembled across arbitrary chunk boundaries; an unknown message type
 * cannot be skipped safely, so it ends the stream.
 */
export class RfbClientFilter {
  #phase: Phase = 'version';
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, allowInput: boolean): Buffer {
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const forward: Buffer[] = [];
    for (;;) {
      const length = this.#nextLength();
      if (length === undefined || this.#buffer.length < length) break;
      const message = this.#buffer.subarray(0, length);
      this.#buffer = this.#buffer.subarray(length);
      const output = this.#accept(message, allowInput);
      if (output) forward.push(output);
    }
    return forward.length === 1
      ? (forward[0] as Buffer)
      : Buffer.concat(forward);
  }

  #nextLength(): number | undefined {
    const data = this.#buffer;
    switch (this.#phase) {
      case 'version':
        return 12;
      case 'security':
      case 'init':
        return 1;
      case 'messages':
        break;
    }
    if (data.length < 1) return undefined;
    const type = data[0] as number;
    const fixed = FIXED_LENGTHS.get(type);
    if (fixed !== undefined) return fixed;
    const length = variableLength(type, data);
    if (length !== undefined && length > MAX_RFB_CLIENT_MESSAGE_BYTES)
      throw new RfbProtocolError(
        `RFB client message exceeds ${MAX_RFB_CLIENT_MESSAGE_BYTES} bytes`,
      );
    return length;
  }

  #accept(message: Buffer, allowInput: boolean): Buffer | undefined {
    switch (this.#phase) {
      case 'version': {
        const match = /^RFB 003\.(\d{3})\n$/.exec(message.toString('latin1'));
        if (!match) throw new RfbProtocolError('Invalid RFB protocol version');
        // 3.3 has no client security choice; the server picks None.
        this.#phase = Number(match[1]) >= 7 ? 'security' : 'init';
        return message;
      }
      case 'security':
        if (message[0] !== SECURITY_NONE)
          throw new RfbProtocolError('Only RFB security type None is relayed');
        this.#phase = 'init';
        return message;
      case 'init':
        this.#phase = 'messages';
        // Never let a viewer disconnect other clients with a non-shared init.
        return Buffer.from([1]);
      case 'messages':
        return allowInput || !isInput(message) ? message : undefined;
    }
  }
}

const FIXED_LENGTHS = new Map<number, number>([
  [0, 20], // SetPixelFormat
  [3, 10], // FramebufferUpdateRequest
  [4, 8], // KeyEvent
  [5, 6], // PointerEvent
  [150, 10], // EnableContinuousUpdates
]);

function variableLength(type: number, data: Buffer): number | undefined {
  switch (type) {
    case 2: // SetEncodings
      return data.length < 4 ? undefined : 4 + 4 * data.readUInt16BE(2);
    case 6: // ClientCutText; negative lengths carry extended clipboard data
      return data.length < 8 ? undefined : 8 + Math.abs(data.readInt32BE(4));
    case 248: // ClientFence
      return data.length < 9 ? undefined : 9 + (data[8] as number);
    case 251: // SetDesktopSize
      return data.length < 8 ? undefined : 8 + 16 * (data[6] as number);
    case 255: // QEMU client message
      if (data.length < 2) return undefined;
      if (data[1] === 0) return 12; // Extended Key Event
      throw new RfbProtocolError(`Unsupported QEMU client message ${data[1]}`);
    default:
      throw new RfbProtocolError(`Unsupported RFB client message type ${type}`);
  }
}

function isInput(message: Buffer): boolean {
  const type = message[0];
  return type === 4 || type === 5 || type === 6 || type === 251 || type === 255;
}
