import type { EncodedImageFrame, RealtimeVideoInput } from '../model-session';

/** Gemini Live samples realtime video at no more than one frame per second. */
const GEMINI_VIDEO_MAX_FPS = 1;
/** A replacement connection only gets the last frame back if it is this fresh. */
const RESEND_MAX_AGE_MS = 30_000;
const MAX_PENDING_DESCRIPTIONS = 8;

export interface GeminiLiveVideoInputStats {
  readonly framesSent: number;
  readonly framesResent: number;
}

export interface GeminiLiveVideoInputHooks {
  /** Sends on the live connection; false when nothing was sent. */
  sendFrame(message: object): boolean;
  /** Records and sends context text the way other session updates are. */
  sendDescription(text: string): void;
  /** True while the model speaks or owes a response. */
  isModelBusy(): boolean;
  now?: () => number;
}

/**
 * Video lane for one Gemini Live session, independent of how the session
 * manages its socket. The session reports connection readiness and idle
 * points; this keeps the newest frame so a replacement connection sees the
 * screen again without waiting for the next sample.
 */
export class GeminiLiveVideoInput implements RealtimeVideoInput {
  readonly maxFps = GEMINI_VIDEO_MAX_FPS;
  private readonly now: () => number;
  private latest: { frame: EncodedImageFrame; receivedAt: number } | undefined;
  private pendingDescriptions: string[] = [];
  private connected = false;
  private closed = false;
  private framesSent = 0;
  private framesResent = 0;

  constructor(private readonly hooks: GeminiLiveVideoInputHooks) {
    this.now = hooks.now ?? Date.now;
  }

  async write(frame: EncodedImageFrame): Promise<void> {
    if (this.closed) return;
    if (frame.mimeType !== 'image/jpeg' || frame.data.byteLength === 0)
      throw new Error('Gemini live video input requires non-empty JPEG');
    this.latest = { frame, receivedAt: this.now() };
    if (this.connected && this.sendFrame(frame)) this.framesSent += 1;
  }

  async describe(text: string): Promise<void> {
    const trimmed = text.trim();
    if (this.closed || !trimmed) return;
    this.pendingDescriptions.push(trimmed);
    if (this.pendingDescriptions.length > MAX_PENDING_DESCRIPTIONS)
      this.pendingDescriptions.shift();
    this.flushDescriptions();
  }

  /**
   * Call once setup completes on the first, a resumed, or a fresh connection.
   * Pass `flushDescriptions: false` when the model is already speaking.
   */
  connectionReady(options: { flushDescriptions?: boolean } = {}): void {
    if (this.closed) return;
    this.connected = true;
    if (options.flushDescriptions !== false) this.flushDescriptions();
    const latest = this.latest;
    if (
      latest &&
      this.now() - latest.receivedAt <= RESEND_MAX_AGE_MS &&
      this.sendFrame(latest.frame)
    )
      this.framesResent += 1;
  }

  /** Call as soon as the current connection stops accepting input. */
  connectionLost(): void {
    this.connected = false;
  }

  /**
   * Client content interrupts generation in Gemini Live, so descriptions wait
   * for a point where the model is neither speaking nor owing a response.
   */
  modelIdle(): void {
    this.flushDescriptions();
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.latest = undefined;
    this.pendingDescriptions = [];
  }

  stats(): GeminiLiveVideoInputStats {
    return { framesSent: this.framesSent, framesResent: this.framesResent };
  }

  private sendFrame(frame: EncodedImageFrame): boolean {
    return this.hooks.sendFrame({
      realtimeInput: {
        video: {
          data: Buffer.from(frame.data).toString('base64'),
          mimeType: frame.mimeType,
        },
        mediaResolution: {
          level:
            frame.detail === 'high'
              ? 'MEDIA_RESOLUTION_HIGH'
              : 'MEDIA_RESOLUTION_LOW',
        },
      },
    });
  }

  private flushDescriptions(): void {
    if (
      !this.connected ||
      this.pendingDescriptions.length === 0 ||
      this.hooks.isModelBusy()
    )
      return;
    this.hooks.sendDescription(this.pendingDescriptions.splice(0).join('\n'));
  }
}
