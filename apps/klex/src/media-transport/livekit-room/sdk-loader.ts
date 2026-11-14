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
  RemoteParticipant,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  AudioFrame as RtcAudioFrame,
  AudioSource as RtcAudioSource,
  AudioStream as RtcAudioStream,
  VideoFrameEvent,
} from '@livekit/rtc-node';

import type { VideoSourceKind } from '../media-transport';
import type {
  LiveKitSdk,
  LiveKitSdkAudioFrame,
  LiveKitSdkAudioPublisher,
  LiveKitSdkAudioStream,
  LiveKitSdkRemoteAudioTrack,
  LiveKitSdkRemoteVideoPublication,
  LiveKitSdkRoom,
  LiveKitSdkVideoFrame,
  LiveKitSdkVideoStream,
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
  readonly participantId: string;

  constructor(
    private readonly rtc: RtcModule,
    private readonly track: RemoteAudioTrack,
    participant: RemoteParticipant,
    fallbackId: string,
  ) {
    this.id = track.sid ?? fallbackId;
    this.participantId = participant.identity;
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

const VIDEO_ROTATIONS = [0, 90, 180, 270] as const;

interface SubscribedVideoTrack {
  readonly track: RemoteVideoTrack;
  readonly generation: number;
}

class RtcVideoStreamAdapter implements LiveKitSdkVideoStream {
  private consumed = false;
  private closedSignal = deferred<undefined>();
  private reader: ReadableStreamDefaultReader<VideoFrameEvent> | undefined;
  private closing = false;

  constructor(
    private readonly rtc: RtcModule,
    private readonly nextTrack: (
      afterGeneration: number,
    ) => Promise<SubscribedVideoTrack | undefined>,
    private readonly maxFps: number,
    private readonly onClose: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<LiveKitSdkVideoFrame> {
    if (this.consumed)
      throw new Error('LiveKit video stream is already consumed');
    this.consumed = true;
    return this.frames();
  }

  private async *frames(): AsyncGenerator<LiveKitSdkVideoFrame> {
    const intervalMs = 1_000 / this.maxFps;
    let lastEmittedAt = Number.NEGATIVE_INFINITY;
    let generation = 0;
    // A resubscription replaces the remote track; follow it rather than end.
    for (;;) {
      const subscribed = await Promise.race([
        this.nextTrack(generation),
        this.closedSignal.promise,
      ]);
      if (!subscribed || this.closing) return;
      generation = subscribed.generation;
      const reader = new this.rtc.VideoStream(subscribed.track).getReader();
      this.reader = reader;
      if (this.closing) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      for (;;) {
        const next = await reader.read();
        if (this.closing) return;
        if (next.done) break;
        const now = performance.now();
        // Decoded frames arrive at the publisher's rate; converting only the
        // sampled ones keeps colour conversion off the hot path.
        if (now - lastEmittedAt < intervalMs) continue;
        lastEmittedAt = now;
        const rgba = next.value.frame.convert(this.rtc.VideoBufferType.RGBA);
        yield {
          data: rgba.data,
          width: rgba.width,
          height: rgba.height,
          rotation: VIDEO_ROTATIONS[next.value.rotation] ?? 0,
        };
      }
    }
  }

  /** Stops reading the current track and waits for its replacement. */
  trackLost(): void {
    void this.reader?.cancel().catch(() => undefined);
  }

  /** Ends the stream because the track went away; keeps the subscription. */
  end(): void {
    if (this.closing) return;
    this.closing = true;
    this.closedSignal.resolve(undefined);
    void this.reader?.cancel().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.end();
    this.onClose();
  }
}

class RtcVideoPublicationAdapter implements LiveKitSdkRemoteVideoPublication {
  readonly id: string;
  readonly participantId: string;
  readonly participantName?: string;
  private track: SubscribedVideoTrack | undefined;
  private generation = 0;
  private unpublished = false;
  private changed = deferred<undefined>();
  private stream: RtcVideoStreamAdapter | undefined;

  constructor(
    private readonly rtc: RtcModule,
    private readonly publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    readonly kind: VideoSourceKind,
    fallbackId: string,
  ) {
    this.id = publication.sid ?? fallbackId;
    this.participantId = participant.identity;
    if (participant.name) this.participantName = participant.name;
  }

  openStream(options: { maxFps: number }): LiveKitSdkVideoStream {
    this.stream?.end();
    const stream = new RtcVideoStreamAdapter(
      this.rtc,
      (afterGeneration) => this.nextTrack(afterGeneration),
      options.maxFps,
      () => {
        if (this.stream !== stream) return;
        this.stream = undefined;
        this.publication.setSubscribed(false);
      },
    );
    this.stream = stream;
    this.publication.setSubscribed(true);
    return stream;
  }

  attachTrack(track: RemoteVideoTrack): void {
    this.generation += 1;
    this.track = { track, generation: this.generation };
    this.notify();
  }

  detachTrack(): void {
    this.track = undefined;
    this.stream?.trackLost();
    this.notify();
  }

  unpublish(): void {
    this.unpublished = true;
    this.track = undefined;
    this.stream?.end();
    this.stream = undefined;
    this.notify();
  }

  private async nextTrack(
    afterGeneration: number,
  ): Promise<SubscribedVideoTrack | undefined> {
    for (;;) {
      if (this.unpublished) return undefined;
      if (this.track && this.track.generation > afterGeneration)
        return this.track;
      await this.changed.promise;
    }
  }

  private notify(): void {
    const changed = this.changed;
    this.changed = deferred();
    changed.resolve(undefined);
  }
}

/** @internal Exported for tests. */
export class RtcRoomAdapter implements LiveKitSdkRoom {
  private readonly room: Room;
  private readonly tracks = new Map<RemoteAudioTrack, RtcRemoteTrackAdapter>();
  private readonly videoPublications = new Map<
    string,
    RtcVideoPublicationAdapter
  >();
  private readonly videoPublishedListeners = new Set<
    (publication: LiveKitSdkRemoteVideoPublication) => void
  >();
  private readonly videoUnpublishedListeners = new Set<
    (publication: LiveKitSdkRemoteVideoPublication) => void
  >();
  private trackSequence = 0;

  constructor(private readonly rtc: RtcModule) {
    this.room = new rtc.Room();
    const { RoomEvent } = rtc;
    this.room.on(RoomEvent.TrackPublished, (publication, participant) =>
      this.handlePublication(publication, participant),
    );
    this.room.on(RoomEvent.TrackUnpublished, (publication) =>
      this.handleUnpublication(publication.sid),
    );
    this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      for (const sid of participant.trackPublications.keys())
        this.handleUnpublication(sid);
    });
    // A muted video publication sends no frames, so it is treated as gone
    // until it is unmuted; clients mute camera toggles instead of
    // unpublishing.
    this.room.on(RoomEvent.TrackMuted, (publication) => {
      const sid = publication.sid;
      if (!sid || !this.videoPublications.has(sid)) return;
      this.handleUnpublication(sid);
      if (publication instanceof rtc.RemoteTrackPublication)
        publication.setSubscribed(false);
    });
    this.room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      if (
        publication instanceof rtc.RemoteTrackPublication &&
        participant instanceof rtc.RemoteParticipant
      )
        this.handlePublication(publication, participant);
    });
    this.room.on(RoomEvent.TrackSubscribed, (track, publication) => {
      if (!(track instanceof rtc.RemoteVideoTrack) || !publication.sid) return;
      this.videoPublications.get(publication.sid)?.attachTrack(track);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      if (!(track instanceof rtc.RemoteVideoTrack) || !publication.sid) return;
      this.videoPublications.get(publication.sid)?.detachTrack();
    });
  }

  // Subscriptions are explicit so video is received and decoded only while
  // a consumer has the source open; microphones are always subscribed.
  async connect(url: string, token: string): Promise<void> {
    await this.room.connect(url, token, {
      autoSubscribe: false,
      dynacast: false,
    });
    for (const participant of this.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values())
        this.handlePublication(publication, participant);
  }

  onVideoTrackPublished(
    listener: (publication: LiveKitSdkRemoteVideoPublication) => void,
  ): () => void {
    this.videoPublishedListeners.add(listener);
    return () => this.videoPublishedListeners.delete(listener);
  }

  onVideoTrackUnpublished(
    listener: (publication: LiveKitSdkRemoteVideoPublication) => void,
  ): () => void {
    this.videoUnpublishedListeners.add(listener);
    return () => this.videoUnpublishedListeners.delete(listener);
  }

  private handlePublication(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant | undefined,
  ): void {
    if (!participant) return;
    const { TrackKind, TrackSource } = this.rtc;
    if (publication.kind === TrackKind.KIND_AUDIO) {
      if (
        publication.source === TrackSource.SOURCE_MICROPHONE &&
        !publication.subscribed
      )
        publication.setSubscribed(true);
      return;
    }
    if (publication.kind !== TrackKind.KIND_VIDEO) return;
    const kind =
      publication.source === TrackSource.SOURCE_SCREENSHARE
        ? 'screenshare'
        : publication.source === TrackSource.SOURCE_CAMERA
          ? 'camera'
          : undefined;
    if (
      !kind ||
      !publication.sid ||
      publication.muted ||
      this.videoPublications.has(publication.sid)
    )
      return;
    const adapter = new RtcVideoPublicationAdapter(
      this.rtc,
      publication,
      participant,
      kind,
      `remote-video-${this.trackSequence++}`,
    );
    this.videoPublications.set(publication.sid, adapter);
    for (const listener of this.videoPublishedListeners) listener(adapter);
  }

  private handleUnpublication(sid: string | undefined): void {
    if (!sid) return;
    const adapter = this.videoPublications.get(sid);
    if (!adapter) return;
    this.videoPublications.delete(sid);
    adapter.unpublish();
    for (const listener of this.videoUnpublishedListeners) listener(adapter);
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
    const handler = (
      track: unknown,
      publication: { source?: unknown },
      participant: RemoteParticipant,
    ) => {
      if (
        !(track instanceof this.rtc.RemoteAudioTrack) ||
        publication.source !== this.rtc.TrackSource.SOURCE_MICROPHONE
      )
        return;
      const adapter = new RtcRemoteTrackAdapter(
        this.rtc,
        track,
        participant,
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
