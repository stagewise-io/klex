import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { LiveKitSdkRemoteVideoPublication } from './livekit-room';
import { RtcRoomAdapter } from './sdk-loader';

const TrackKind = { KIND_AUDIO: 1, KIND_VIDEO: 2 };
const TrackSource = {
  SOURCE_CAMERA: 1,
  SOURCE_MICROPHONE: 2,
  SOURCE_SCREENSHARE: 3,
};
const RoomEvent = {
  TrackPublished: 'trackPublished',
  TrackUnpublished: 'trackUnpublished',
  ParticipantDisconnected: 'participantDisconnected',
  TrackSubscribed: 'trackSubscribed',
  TrackUnsubscribed: 'trackUnsubscribed',
  TrackMuted: 'trackMuted',
  TrackUnmuted: 'trackUnmuted',
};

class FakeRemoteTrackPublication {
  subscribed = false;
  readonly setSubscribed = vi.fn((subscribed: boolean) => {
    this.subscribed = subscribed;
  });
  constructor(
    readonly sid: string,
    readonly source: number,
    public muted = false,
    readonly kind = TrackKind.KIND_VIDEO,
  ) {}
}

class FakeRemoteParticipant {
  readonly identity = 'peer';
  readonly name = 'Dana';
  readonly trackPublications = new Map<string, FakeRemoteTrackPublication>();
}

class FakeRoom extends EventEmitter {
  static last: FakeRoom | undefined;
  readonly remoteParticipants = new Map<string, FakeRemoteParticipant>();
  constructor() {
    super();
    FakeRoom.last = this;
  }
  async connect(): Promise<void> {}
}

const rtc = {
  Room: FakeRoom,
  RoomEvent,
  TrackKind,
  TrackSource,
  RemoteVideoTrack: class {},
  RemoteTrackPublication: FakeRemoteTrackPublication,
  RemoteParticipant: FakeRemoteParticipant,
} as unknown as ConstructorParameters<typeof RtcRoomAdapter>[0];

function setup() {
  const adapter = new RtcRoomAdapter(rtc);
  const room = FakeRoom.last as FakeRoom;
  const published: LiveKitSdkRemoteVideoPublication[] = [];
  const unpublished: LiveKitSdkRemoteVideoPublication[] = [];
  adapter.onVideoTrackPublished((publication) => published.push(publication));
  adapter.onVideoTrackUnpublished((publication) =>
    unpublished.push(publication),
  );
  return { adapter, room, published, unpublished };
}

describe('RtcRoomAdapter video mute', () => {
  it('treats a muted publication as unpublished until it is unmuted', () => {
    const { room, published, unpublished } = setup();
    const participant = new FakeRemoteParticipant();
    const camera = new FakeRemoteTrackPublication(
      'camera',
      TrackSource.SOURCE_CAMERA,
    );
    room.emit(RoomEvent.TrackPublished, camera, participant);
    expect(published.map(({ id, kind }) => [id, kind])).toEqual([
      ['camera', 'camera'],
    ]);
    published[0]?.openStream({ maxFps: 2 });
    expect(camera.subscribed).toBe(true);

    camera.muted = true;
    room.emit(RoomEvent.TrackMuted, camera, participant);
    expect(unpublished).toEqual([published[0]]);
    // No frames arrive while muted, so the subscription is released.
    expect(camera.subscribed).toBe(false);
    room.emit(RoomEvent.TrackMuted, camera, participant);
    expect(unpublished).toHaveLength(1);

    camera.muted = false;
    room.emit(RoomEvent.TrackUnmuted, camera, participant);
    expect(published).toHaveLength(2);
    expect(published[1]).not.toBe(published[0]);
    expect(published[1]?.id).toBe('camera');
  });

  it('announces a publication that starts muted only once it is unmuted', async () => {
    const { adapter, room, published } = setup();
    const participant = new FakeRemoteParticipant();
    const existing = new FakeRemoteTrackPublication(
      'existing',
      TrackSource.SOURCE_SCREENSHARE,
      true,
    );
    participant.trackPublications.set('existing', existing);
    room.remoteParticipants.set('peer', participant);
    await adapter.connect('wss://example.invalid', 'token');
    const late = new FakeRemoteTrackPublication(
      'late',
      TrackSource.SOURCE_CAMERA,
      true,
    );
    room.emit(RoomEvent.TrackPublished, late, participant);
    expect(published).toEqual([]);

    existing.muted = false;
    room.emit(RoomEvent.TrackUnmuted, existing, participant);
    late.muted = false;
    room.emit(RoomEvent.TrackUnmuted, late, participant);
    expect(published.map(({ id, kind }) => [id, kind])).toEqual([
      ['existing', 'screenshare'],
      ['late', 'camera'],
    ]);
  });

  it('ignores mute events for microphones', () => {
    const { room, published, unpublished } = setup();
    const participant = new FakeRemoteParticipant();
    const microphone = new FakeRemoteTrackPublication(
      'microphone',
      TrackSource.SOURCE_MICROPHONE,
      false,
      TrackKind.KIND_AUDIO,
    );
    room.emit(RoomEvent.TrackPublished, microphone, participant);
    expect(microphone.subscribed).toBe(true);
    room.emit(RoomEvent.TrackMuted, microphone, participant);
    room.emit(RoomEvent.TrackUnmuted, microphone, participant);
    expect(microphone.subscribed).toBe(true);
    expect([published, unpublished]).toEqual([[], []]);
  });
});
