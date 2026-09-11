# Realtime Session Architecture

## Boundary

The public `Realtime` module is the enabled application's lifecycle boundary started and closed by `main.ts`. It requires a resolved provider, the router as its `ConversationHost`, and the exact transport connector registry used to advertise MCP transport profiles. It resolves the selected model-session implementation and creates an internal realtime session coordinator. When no compatible provider is selected, `main.ts` creates no registry, advertises no Realtime Media capability, and creates no `Realtime` module.

The coordinator owns accepted media-session lifetimes, but inference is deliberately not independent from chat. Every accepted call must first acquire an exclusive lease on the primary chat session's generation lane. The lease is the only route to canonical context, live notifications, tools, and transcript commitment.

```text
MCP Realtime Media control plane
  -> session-offered
  -> acquire primary-session generation lease
  -> accept/reject
  -> bootstrap canonical context + update watermark
  -> MediaTransport.audioSources -> RealtimeModelSession.audioInputs
  -> ordered canonical updates/tools/transcripts via InteractionLease
  -> RealtimeModelSession.audioOutput -> MediaTransport.audioOutput
  -> session-ended or local terminal condition
  -> exactly-once cleanup and lease release
```

MCP owns capability negotiation, the ephemeral lifecycle stream, connection
availability, and accept/reject/end operations. A media connector owns its media-plane resources. A realtime model session owns provider inference resources and semantic wire conversion. The primary session remains authoritative for canonical history and tool execution. These roles have distinct creation boundaries but share one coordinated lifecycle. The coordinator borrows module-level dependencies and closes only the per-session transport, model session, context handle, and interaction lease it creates.

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

Sessions are keyed by MCP namespace and external media session ID. An expired offer is rejected. For a valid offer, the coordinator first reserves the primary session's generation lane. Concurrent offers are rejected rather than queued or substituted. Acquisition waits for the chat loop's safe commit boundary: model generation may be interrupted, but a dispatched tool must settle and be committed before bootstrap.

After lease acquisition, the coordinator accepts the remote offer, connects its descriptor, and calls `lease.bootstrap()`. Bootstrap atomically prepares instructions, transformed canonical history, non-secret model metadata, JSON-Schema tool descriptors, a context revision, and an update watermark. The model session is created and made ready before the scoped context handle is committed and audio pumps are enabled. Any setup failure rolls the handle back.

The coordinator then explicitly routes audio:

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

Each session has one abort controller and one stored `finish()` promise. Remote end, transport closure or failure, model-session closure or failure, update/event/audio pump failure, lease revocation, MCP unavailability, and coordinator shutdown all converge on that promise. Cleanup order is fixed: abort pumps; await setup convergence; close provider and transport; roll back any unsettled context; commit the canonical session end when applicable; release the lease; await pumps; then notify the remote endpoint when applicable. Releasing before awaiting the update pump is required because release closes the iterable. This guarantees idempotent signaling and exactly-once cleanup even when terminal events race acceptance or connection.

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

## Semantic updates, tools, and replay

The lease's bootstrap watermark and ordered update iterable remove the snapshot/subscription race. Accepted notifications are canonical before forwarding and preserve stable event IDs, source metadata, monotonic update sequences, and explicit response policy. The model session acknowledges an update only after provider delivery. Pending updates are bounded; overflow revokes the lease instead of dropping canonical input.

OpenAI can request tools, but Klex remains the authority. The adapter emits a provider-neutral tool request. The coordinator commits the call, executes it through the lease's shared schema-validating, timed, cancellable, execution-ID-deduplicated executor, commits the result, then sends provider output. The provider never receives executable tool functions.

Only finalized transcripts become canonical commits. Partial deltas are not history. Interrupted assistant text is limited to the portion synchronized with audio playout. Commit event IDs suppress duplicates.

One bounded provider reconnect grace window is available. A replacement connection is configured, canonical history is reseeded, and unacknowledged updates and tool results are replayed in original order. At most one response is requested after replay. Stable update, transcript, and execution IDs prevent duplicate commits and side effects. Exhausted attempts or an expired grace window ends the call and releases the lane.

## OpenAI Realtime model session

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

The provider connection is session-scoped. Setup timeout, malformed provider data, provider errors, exhausted reconnect, abort, and explicit close converge on one idempotent model-session closure. Provider credentials remain in the server-side WebSocket authorization header and are never included in media frames or logs.

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

## Observability and data handling

Lifecycle logs correlate `leaseId`, `canonicalSessionId`, `externalMediaSessionId`, and MCP namespace. Safe-boundary acquisition records `handoffDurationMs`; successful bootstrap records `historyRevision` and `updateWatermark`; update forwarding records `updateSequence`; tool dispatch records `toolExecutionId`; provider recovery records `reconnectAttempt`; and teardown records `releaseReason`. Errors retain these identifiers where the lifecycle has acquired them.

Observability must never include transcript bodies, tool arguments or results, tool secrets, provider credentials, or binary media. Counts, sequence numbers, non-secret tool names, model metadata, closure classes, and bounded error objects are sufficient for diagnosis.

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
