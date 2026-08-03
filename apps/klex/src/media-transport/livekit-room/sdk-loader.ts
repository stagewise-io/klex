import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAsset, isSea } from 'node:sea';

import type {
  LocalAudioTrack,
  LocalTrackPublication,
  RemoteAudioTrack,
  Room,
  AudioFrame as RtcAudioFrame,
  AudioSource as RtcAudioSource,
  AudioStream as RtcAudioStream,
} from '@livekit/rtc-node';

import type {
  LiveKitSdk,
  LiveKitSdkAudioFrame,
  LiveKitSdkAudioPublisher,
  LiveKitSdkAudioStream,
  LiveKitSdkRemoteAudioTrack,
  LiveKitSdkRoom,
} from './livekit-room';

type RtcModule = typeof import('@livekit/rtc-node');

const LIVEKIT_NATIVE_ASSET = 'livekit-rtc.node';
const LIVEKIT_NATIVE_VERSION = '0.12.68';

export interface LiveKitNativeRuntimeOptions {
  readonly sea?: boolean;
  readonly asset?: ArrayBuffer;
  readonly cacheDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

export async function prepareLiveKitNativeRuntime(
  options: LiveKitNativeRuntimeOptions = {},
): Promise<string | undefined> {
  const sea = options.sea ?? isSea();
  if (!sea) return undefined;
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const cacheDirectory =
    options.cacheDirectory ?? join(homedir(), '.cache', 'klex', 'native');
  const target = join(
    cacheDirectory,
    `rtc-node-${LIVEKIT_NATIVE_VERSION}-${platform}-${architecture}.node`,
  );
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(cacheDirectory, 0o700);
  try {
    const existing = await stat(target);
    if (!existing.isFile() || existing.size === 0)
      throw new Error('LiveKit native cache entry is invalid');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const asset = options.asset ?? getAsset(LIVEKIT_NATIVE_ASSET);
      await writeFile(temporary, Buffer.from(asset), {
        flag: 'wx',
        mode: 0o600,
      });
      try {
        await rename(temporary, target);
      } catch (renameError) {
        if (
          !(renameError instanceof Error) ||
          !('code' in renameError) ||
          renameError.code !== 'EEXIST'
        )
          throw renameError;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  await chmod(target, 0o600);
  environment.NAPI_RS_NATIVE_LIBRARY_PATH = target;
  return target;
}

class RtcStreamAdapter implements LiveKitSdkAudioStream {
  private iterator: AsyncIterator<LiveKitSdkAudioFrame> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly stream: RtcAudioStream) {}

  [Symbol.asyncIterator](): AsyncIterator<LiveKitSdkAudioFrame> {
    if (this.iterator)
      throw new Error('LiveKit audio stream is already consumed');
    this.iterator = this.stream[Symbol.asyncIterator]();
    return this.iterator;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const close = this.iterator?.return
      ? this.iterator.return().then(() => undefined)
      : this.stream.cancel();
    this.closePromise = close.catch((error: unknown) => {
      if (!isLockedStreamError(error)) throw error;
    });
    return this.closePromise;
  }
}

function isLockedStreamError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    'code' in error &&
    error.code === 'ERR_INVALID_STATE' &&
    error.message.includes('ReadableStream is locked')
  );
}

class RtcRemoteTrackAdapter implements LiveKitSdkRemoteAudioTrack {
  readonly id: string;

  constructor(
    private readonly rtc: RtcModule,
    private readonly track: RemoteAudioTrack,
    fallbackId: string,
  ) {
    this.id = track.sid ?? fallbackId;
  }

  openStream(options: {
    sampleRate: number;
    channels: number;
    frameSizeMs: number;
  }): LiveKitSdkAudioStream {
    return new RtcStreamAdapter(
      new this.rtc.AudioStream(this.track, {
        sampleRate: options.sampleRate,
        numChannels: options.channels,
        frameSizeMs: options.frameSizeMs,
      }),
    );
  }
}

class RtcPublisherAdapter implements LiveKitSdkAudioPublisher {
  constructor(
    private readonly rtc: RtcModule,
    private readonly room: Room,
    private readonly source: RtcAudioSource,
    private readonly track: LocalAudioTrack,
    private readonly publication: LocalTrackPublication,
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {}

  async capture(data: Int16Array, samplesPerChannel: number): Promise<void> {
    const frame: RtcAudioFrame = new this.rtc.AudioFrame(
      data,
      this.sampleRate,
      this.channels,
      samplesPerChannel,
    );
    await this.source.captureFrame(frame);
  }

  async close(): Promise<void> {
    this.source.clearQueue();
    await Promise.allSettled([
      this.publication.sid
        ? this.room.localParticipant?.unpublishTrack(
            this.publication.sid,
            false,
          )
        : undefined,
      this.track.close(false),
      this.source.close(),
    ]);
  }
}

class RtcRoomAdapter implements LiveKitSdkRoom {
  private readonly room: Room;
  private readonly tracks = new Map<RemoteAudioTrack, RtcRemoteTrackAdapter>();
  private trackSequence = 0;

  constructor(private readonly rtc: RtcModule) {
    this.room = new rtc.Room();
  }

  connect(url: string, token: string): Promise<void> {
    return this.room.connect(url, token, {
      autoSubscribe: true,
      dynacast: false,
    });
  }

  async publishAudio(options: {
    sampleRate: number;
    channels: number;
    queueSizeMs: number;
  }): Promise<LiveKitSdkAudioPublisher> {
    const source = new this.rtc.AudioSource(
      options.sampleRate,
      options.channels,
      options.queueSizeMs,
    );
    const track = this.rtc.LocalAudioTrack.createAudioTrack(
      'klex-loopback',
      source,
    );
    const localParticipant = this.room.localParticipant;
    if (!localParticipant) {
      await Promise.allSettled([track.close(false), source.close()]);
      throw new Error('LiveKit local participant is unavailable');
    }
    const publication = await localParticipant.publishTrack(
      track,
      new this.rtc.TrackPublishOptions({
        source: this.rtc.TrackSource.SOURCE_MICROPHONE,
      }),
    );
    return new RtcPublisherAdapter(
      this.rtc,
      this.room,
      source,
      track,
      publication,
      options.sampleRate,
      options.channels,
    );
  }

  onAudioTrackSubscribed(
    listener: (track: LiveKitSdkRemoteAudioTrack) => void,
  ): () => void {
    const handler = (track: unknown, publication: { source?: unknown }) => {
      if (
        !(track instanceof this.rtc.RemoteAudioTrack) ||
        publication.source !== this.rtc.TrackSource.SOURCE_MICROPHONE
      )
        return;
      const adapter = new RtcRemoteTrackAdapter(
        this.rtc,
        track,
        `remote-audio-${this.trackSequence++}`,
      );
      this.tracks.set(track, adapter);
      listener(adapter);
    };
    this.room.on(this.rtc.RoomEvent.TrackSubscribed, handler);
    return () => this.room.off(this.rtc.RoomEvent.TrackSubscribed, handler);
  }

  onAudioTrackUnsubscribed(
    listener: (track: LiveKitSdkRemoteAudioTrack) => void,
  ): () => void {
    const handler = (track: unknown) => {
      if (!(track instanceof this.rtc.RemoteAudioTrack)) return;
      const adapter = this.tracks.get(track);
      if (!adapter) return;
      this.tracks.delete(track);
      listener(adapter);
    };
    this.room.on(this.rtc.RoomEvent.TrackUnsubscribed, handler);
    return () => this.room.off(this.rtc.RoomEvent.TrackUnsubscribed, handler);
  }

  onDisconnected(listener: (reason: string) => void): () => void {
    const handler = (reason: unknown) => listener(String(reason));
    this.room.on(this.rtc.RoomEvent.Disconnected, handler);
    return () => this.room.off(this.rtc.RoomEvent.Disconnected, handler);
  }

  disconnect(): Promise<void> {
    return this.room.disconnect();
  }
}

class RtcSdkAdapter implements LiveKitSdk {
  constructor(private readonly rtc: RtcModule) {}

  createRoom(): LiveKitSdkRoom {
    return new RtcRoomAdapter(this.rtc);
  }

  async dispose(): Promise<void> {
    this.rtc.dispose();
  }
}

export async function loadLiveKitSdk(): Promise<LiveKitSdk> {
  try {
    await prepareLiveKitNativeRuntime();
    return new RtcSdkAdapter(await import('@livekit/rtc-node'));
  } catch (error) {
    throw new Error(
      'LiveKit native runtime is unavailable for this platform or installation',
      { cause: error },
    );
  }
}
