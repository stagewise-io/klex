import { Room, RoomEvent, Track } from 'livekit-client';

interface SessionOfferResponse {
  session: { sessionId: string };
  participant?: {
    transport: { profile: 'livekit-room'; url: string; token: string };
  };
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required element is missing: ${selector}`);
  return element;
}

const startButton = requiredElement<HTMLButtonElement>('#start-call');
const stopButton = requiredElement<HTMLButtonElement>('#stop-call');
const shareButton = requiredElement<HTMLButtonElement>('#share-screen');
const cameraButton = requiredElement<HTMLButtonElement>('#camera');
const status = requiredElement<HTMLElement>('#call-status');
const audio = requiredElement<HTMLElement>('#remote-audio');

let room: Room | undefined;
let sessionId: string | undefined;

function setStatus(message: string): void {
  status.textContent = message;
}

const LIVE_STATUS = 'Live — speak into your microphone; Klex should echo it';

function setSharing(sharing: boolean): void {
  shareButton.textContent = sharing ? 'Stop sharing' : 'Share screen';
  shareButton.setAttribute('aria-pressed', String(sharing));
}

function setCamera(on: boolean): void {
  cameraButton.textContent = on ? 'Stop camera' : 'Camera';
  cameraButton.setAttribute('aria-pressed', String(on));
}

/** Describes what Klex can currently see; both tracks may be live at once. */
function liveStatus(activeRoom: Room): string {
  const { localParticipant } = activeRoom;
  const visible = [
    localParticipant.isScreenShareEnabled ? 'your shared screen' : undefined,
    localParticipant.isCameraEnabled ? 'your camera' : undefined,
  ].filter((entry) => entry !== undefined);
  return visible.length === 0
    ? LIVE_STATUS
    : `Live — Klex can see ${visible.join(' and ')} (about one frame per second)`;
}

async function stop(): Promise<void> {
  const endingSessionId = sessionId;
  sessionId = undefined;
  await room?.disconnect();
  room = undefined;
  audio.replaceChildren();
  if (endingSessionId) {
    await fetch(`/api/realtime/sessions/${endingSessionId}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  startButton.disabled = false;
  stopButton.disabled = true;
  setSharing(false);
  setCamera(false);
  shareButton.disabled = true;
  cameraButton.disabled = true;
  setStatus('Idle');
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  setStatus('Creating session…');
  try {
    const response = await fetch('/api/realtime/sessions', { method: 'POST' });
    const body = (await response.json()) as SessionOfferResponse & {
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? 'Could not create session');
    if (!body.participant)
      throw new Error('Simulator has no LiveKit credentials configured');
    sessionId = body.session.sessionId;
    const nextRoom = new Room({ adaptiveStream: true, dynacast: false });
    room = nextRoom;
    nextRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      audio.append(element);
    });
    nextRoom.on(RoomEvent.TrackUnsubscribed, (track) => track.detach());
    nextRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) setSharing(false);
      else if (publication.source === Track.Source.Camera) setCamera(false);
      else return;
      if (room === nextRoom) setStatus(liveStatus(nextRoom));
    });
    nextRoom.on(RoomEvent.Disconnected, () => {
      if (room === nextRoom) void stop();
    });
    const { url, token } = body.participant.transport;
    await nextRoom.connect(url, token, { autoSubscribe: true });
    await nextRoom.localParticipant.setMicrophoneEnabled(true);
    stopButton.disabled = false;
    shareButton.disabled = false;
    cameraButton.disabled = false;
    setStatus(LIVE_STATUS);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    await stop();
  }
});

stopButton.addEventListener('click', () => void stop());
/** Toggles one published video track; failures leave the call running. */
async function toggleVideo(
  button: HTMLButtonElement,
  enabled: (activeRoom: Room) => boolean,
  apply: (activeRoom: Room, on: boolean) => Promise<unknown>,
  show: (on: boolean) => void,
): Promise<void> {
  const activeRoom = room;
  if (!activeRoom) return;
  const on = !enabled(activeRoom);
  button.disabled = true;
  try {
    await apply(activeRoom, on);
    if (room !== activeRoom) return;
    show(on);
    setStatus(liveStatus(activeRoom));
  } catch (error) {
    // Cancelling a browser picker or permission prompt rejects; the call
    // itself is unaffected.
    if (room === activeRoom)
      setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    if (room === activeRoom) button.disabled = false;
  }
}

shareButton.addEventListener(
  'click',
  () =>
    void toggleVideo(
      shareButton,
      (activeRoom) => activeRoom.localParticipant.isScreenShareEnabled,
      (activeRoom, on) =>
        activeRoom.localParticipant.setScreenShareEnabled(on, { audio: false }),
      setSharing,
    ),
);
cameraButton.addEventListener(
  'click',
  () =>
    void toggleVideo(
      cameraButton,
      (activeRoom) => activeRoom.localParticipant.isCameraEnabled,
      (activeRoom, on) => activeRoom.localParticipant.setCameraEnabled(on),
      setCamera,
    ),
);
window.addEventListener('pagehide', () => void room?.disconnect());
