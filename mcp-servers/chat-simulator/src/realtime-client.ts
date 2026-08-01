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
const status = requiredElement<HTMLElement>('#call-status');
const audio = requiredElement<HTMLElement>('#remote-audio');

let room: Room | undefined;
let sessionId: string | undefined;

function setStatus(message: string): void {
  status.textContent = message;
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
    nextRoom.on(RoomEvent.Disconnected, () => {
      if (room === nextRoom) void stop();
    });
    const { url, token } = body.participant.transport;
    await nextRoom.connect(url, token, { autoSubscribe: true });
    await nextRoom.localParticipant.setMicrophoneEnabled(true);
    stopButton.disabled = false;
    setStatus('Live — speak into your microphone; Klex should echo it');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    await stop();
  }
});

stopButton.addEventListener('click', () => void stop());
window.addEventListener('pagehide', () => void room?.disconnect());
