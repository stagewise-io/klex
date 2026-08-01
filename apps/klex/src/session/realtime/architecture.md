# Realtime Session Architecture

## Boundary

The realtime session coordinator owns accepted audio-session lifetimes. It is
independent from chat sessions and model generations.

```text
MCP Realtime Media control plane
  -> session-offered
  -> coordinator accept/reject
  -> MediaTransportConnector
  -> MediaTransport <-> RealtimeAudioProcessor
  -> session-ended or local terminal condition
  -> exactly-once cleanup
```

MCP owns capability negotiation, the ephemeral lifecycle stream, connection
availability, and accept/reject/end operations. A media connector owns its
media-plane resources. An audio processor owns audio-generation resources. The
coordinator borrows all three dependencies and closes only the per-session
transport and processor instances they create.

## Audio contract

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
returned descriptor, creates a processor, and starts two pumps:

1. transport input to processor input;
2. processor output to transport output.

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
local microphone track, and selects the first subscribed remote microphone
track. Concurrent remote audio tracks are ignored until the selected track is
unsubscribed; a later eligible track can then replace it. Reconnect events are
transient. Explicit close, abort, connector shutdown, and terminal room
disconnection end the transport.

LiveKit is normalized at the adapter boundary to signed 16-bit little-endian PCM,
48,000 Hz, mono, with 20 ms incoming frames where the SDK supports that cadence.
The adapter copies buffers at both SDK boundaries. Incoming delivery and outgoing
SDK playout are bounded, and all writes are awaited. Arbitrary output resampling
belongs in a future model bridge rather than this transport.

`realtime.mode: "loopback"` composes the adapter with a bounded one-frame
loopback processor. Loopback is a diagnostic interim processor, not a realtime
AI provider. Startup subscribes the coordinator before MCP connections can
deliver offers. Shutdown closes the coordinator and its sessions, then the
connector and native SDK, and only then MCP.

## Deterministic fixture

The deterministic connector, transport, and echo processor are test fixtures.
They accept the negotiated descriptor as opaque input, provide bounded queues,
and expose controls for frame injection, outbound observation, closure, failure,
and cancellation. They are not advertised as an MCP transport and are not wired
into the production process.
