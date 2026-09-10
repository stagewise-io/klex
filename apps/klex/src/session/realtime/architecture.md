# Realtime Session Architecture

## Boundary

The public `Realtime` module is the enabled application's lifecycle boundary
started and closed by `main.ts`. It requires a resolved provider and takes
lifecycle ownership of the exact transport connector registry used to advertise
MCP transport profiles. It resolves the selected processor implementation and
creates an internal realtime session coordinator. When no compatible provider
is selected, `main.ts` creates no registry, advertises no Realtime Media
capability, and creates no `Realtime` module. The coordinator owns accepted
audio-session lifetimes and remains independent from chat sessions and model
generations.

```text
MCP Realtime Media control plane
  -> session-offered
  -> coordinator accept/reject
  -> MediaTransportConnector
  -> MediaTransport.audioSources -> RealtimeProcessor.audioInputs
  -> RealtimeProcessor.audioOutput -> MediaTransport.audioOutput
  -> session-ended or local terminal condition
  -> exactly-once cleanup
```

MCP owns capability negotiation, the ephemeral lifecycle stream, connection
availability, and accept/reject/end operations. A media connector owns its
media-plane resources. A realtime processor owns inference or transformation
resources. These roles have distinct creation boundaries but return connected
endpoints with the same lifecycle but directional audio capabilities. The
coordinator borrows all three dependencies and closes only the per-session
transport and processor instances they create.

## Endpoint and audio contracts

Every connected endpoint exposes an idempotent `close()` and a terminal
`closed` promise. A transport exposes a long-lived `audioSources` discovery
iterable plus one awaited, backpressured `audioOutput` sink. Each discovered
source has an immutable participant/track identity, its own ordered readable,
and a terminal promise. The processor accepts distinct sources concurrently
through `audioInputs` and exposes one generated `audioOutput` iterable. A
processor must adapt those inputs to its provider's limits instead of rejecting
a normal second source. Implementations must bound buffers independently, and
endpoint teardown owns all source-consumption tasks.

`AudioFrame` is headless signed 16-bit little-endian PCM. Every frame declares
its sample rate, channel count, sequence, microsecond timestamp, and byte
payload. There are no browser media types. The core contract does not resample,
transcode, infer timing, or normalize formats.

Frame ownership transfers when a frame is yielded or sent. Implementations must
not mutate it afterward. Writes are awaited in both directions, making
backpressure part of the contract rather than an optional adapter behavior.
Adapters and processors must bound internal buffering.

## Session lifecycle

Sessions are keyed by MCP namespace and protocol session ID. An offer is
rejected if already expired. Otherwise the coordinator accepts it, connects the
returned descriptor, creates a processor, and explicitly routes audio:

1. every source from `transport.audioSources` is attached through
   `processor.audioInputs.attach()` without waiting for that source to end;
2. `processor.audioOutput` is piped to `transport.audioOutput.write()`.

The routing remains explicit application policy rather than automatically
connecting properties with matching names.

Production advertises the static `livekit-room` audio capability and transfers
a typed LiveKit connector to the enabled `Realtime` module, which closes it
during startup rollback or normal shutdown. The coordinator extracts accepted
LiveKit descriptors and rejects unknown profiles before connection. Supporting
another transport will require restoring a typed dispatch boundary rather than
adding provider-specific branching to media routing.

Each session has one abort controller and one stored `finish()` promise. Remote
end, transport closure or failure, processor closure or failure, pump failure,
MCP unavailability, and coordinator shutdown all converge on that promise.
This guarantees idempotent end signaling and exactly-once resource cleanup even
when terminal events race acceptance or connection.

A remote `session-ended` or MCP disconnect does not send `end` back. Local media
or processor termination and coordinator shutdown send `end` once on a
best-effort basis after acceptance. MCP disconnect aborts matching sessions
without attempting an operation on the unavailable connection.

## LiveKit transport

The production `livekit-room` adapter validates every accepted descriptor before
loading the native SDK. It joins the room with auto-subscription, publishes one
local microphone track, and exposes every subscribed remote microphone track
as an independently attributed audio source. Unpublishing one track completes
only that source; later tracks remain discoverable. Reconnect events are transient. Explicit close, abort, connector shutdown, and terminal room
disconnection end the transport.

LiveKit is normalized at the adapter boundary to signed 16-bit little-endian PCM,
48,000 Hz, mono, with 20 ms incoming frames where the SDK supports that cadence.
The adapter copies buffers at both SDK boundaries. Incoming delivery and outgoing
SDK playout are bounded, and all writes are awaited. Provider-specific resampling belongs in the model bridge rather than this
transport.

## OpenAI Realtime processor

`openai-realtime` preserves the three independent planes: MCP remains the
control and lifecycle plane, LiveKit remains the caller media plane, and Klex
opens a server-to-server authenticated WebSocket as the model inference plane.
The WebSocket carries provider control events and 24 kHz mono PCM16. It is not a
second room or caller transport.

The processor accepts multiple concurrent attributed sources and attaches them
to a reusable, processor-owned PCM mixer. The mixer maintains bounded per-source
buffers, assembles arbitrary chunks into 20 ms playout quanta, lets ready sources
continue when another source has no complete quantum, and combines overlapping
samples with saturating PCM16 addition. It emits one 48 kHz mono stream with its
own sequence and timestamp timeline for OpenAI's single logical input. Source
failures and malformed frames fail the processor; one source ending does not end
or reset the aggregate input.

The mixed stream is converted from 48 kHz PCM to OpenAI's 24 kHz input, and
response audio is converted back to 48 kHz, 20 ms frames. Both conversions use a
stateful low-pass streaming converter rather than sample dropping. Provider VAD
creates responses and reports speech interruption. Interruption cancels and
truncates the active response, resets output converter state, and discards
buffered or stale assistant audio before it reaches LiveKit.

The provider connection is session-scoped. Setup timeout, malformed provider
data, provider errors, unexpected close, abort, and explicit close converge on
one idempotent processor closure. Provider credentials remain in the
server-side WebSocket authorization header and are never included in media
frames or logs.

Realtime availability is derived from `modelSelection.voice.sts`. Each ordered
candidate must explicitly declare `capabilities.voice.sts: true`; Klex does not
infer support from model names. The candidate endpoint format selects an
installed provider adapter. Full `openai` and compatible `realtime` endpoints
currently map to the OpenAI Realtime processor. An empty STS selection disables
Realtime Media capability advertisement. TTS and STT selections reserve future
composed-pipeline roles but do not activate calls yet.

Voice, instructions, and VAD use provider-owned defaults until Klex exposes a
user or agent preference mechanism. Startup starts the `Realtime` module, which subscribes its coordinator before
MCP connections can deliver offers. Shutdown closes the coordinator and its
sessions, then the connector and native SDK, and only then MCP.

## Future modalities

The connected endpoint shape provides a place for additional independently
buffered capabilities, but the current implementation supports audio only. A
future modality must get a requirement-driven typed contract and its own
ordering, buffering, backpressure, and routing policy. Video representation
cannot be fixed before choosing between sampled images, decoded frames, encoded
frames, or native track handles. Text and transcripts are semantic events rather
than audio-like frames, while provider tool calls belong to Klex orchestration.
The attributed-source contract preserves participant and track lifecycle.
OpenAI currently chooses a mix-all policy; future processors may instead use
provider-native routing, active-speaker selection, or another explicit policy.
Mutable participant metadata and targeted outputs are also deferred. These concerns must not be collapsed into one universal frame union
or automatically piped between endpoints.

The public `realtime.test.ts` covers lifecycle composition and ownership.
Internal `session-coordinator.test.ts` and
`session-coordinator.integration.test.ts` cover session orchestration with
private test-local endpoint fakes. No diagnostic or synthetic media
implementation is exported from the production module.
