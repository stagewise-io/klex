# Realtime Session Architecture

## Boundary

The public `Realtime` module is the enabled application's lifecycle boundary started and closed by `main.ts`. It requires a resolved provider, the session host as its `ConversationHost`, and the transport connector registry. It resolves the selected model-session implementation and creates an internal realtime session coordinator. When no compatible provider is selected, no `Realtime` module is created.

The coordinator owns accepted media-session lifetimes, but inference is not independent from chat. Every accepted call must first acquire an exclusive lease on the default chat session's generation lane. The lease is the only route to canonical context, live notifications, tools, and transcript commitment.

```
MCP Realtime Media control plane
  -> session-offered
  -> acquire default-session generation lease
  -> accept/reject
  -> bootstrap canonical context + update watermark
  -> MediaTransport.audioSources -> RealtimeModelSession.audioInputs
  -> ordered canonical updates/tools/transcripts via InteractionLease
  -> RealtimeModelSession.audioOutput -> MediaTransport.audioOutput
  -> session-ended or local terminal condition
  -> exactly-once cleanup and lease release
```

MCP owns capability negotiation and the ephemeral lifecycle stream. A media connector owns its media-plane resources. A realtime model session owns provider inference resources. The default session remains authoritative for canonical history and tool execution.

## Endpoint and audio contracts

Every connected endpoint exposes an idempotent `close()` and a terminal `closed` promise. A transport exposes a long-lived `audioSources` discovery iterable plus one awaited, backpressured `audioOutput` sink. Each discovered source has an immutable participant/track identity, its own ordered readable, and a terminal promise.

`AudioFrame` is headless signed 16-bit little-endian PCM. Every frame declares its sample rate, channel count, sequence, microsecond timestamp, and byte payload. The core contract does not resample, transcode, infer timing, or normalize formats. Frame ownership transfers when yielded or sent; implementations must not mutate it afterward.

## Session lifecycle

Sessions are keyed by MCP namespace and external media session ID. Expired offers are rejected. For a valid offer, the coordinator reserves the default session's generation lane — concurrent offers are rejected. Acquisition waits for the chat loop's safe commit boundary: model generation may be interrupted, but a dispatched tool must settle and be committed before bootstrap.

After lease acquisition, the coordinator accepts the remote offer, connects its descriptor, and calls `lease.bootstrap()`. Bootstrap atomically prepares instructions, transformed canonical history, model metadata, tool descriptors, a context revision, and an update watermark. The model session is created and made ready before the context handle is committed and audio pumps are enabled. Any setup failure rolls the handle back.

The coordinator then explicitly routes audio: each source from `transport.audioSources` is attached through `processor.audioInputs.attach()`, and `processor.audioOutput` is piped to `transport.audioOutput.write()`.

Each session has one abort controller and one stored `finish()` promise. All terminal events — remote end, transport closure, model-session failure, lease revocation, MCP unavailability, coordinator shutdown — converge on that promise. Cleanup order is fixed: abort pumps; await setup convergence; close provider and transport; roll back unsettled context; commit canonical session end; release lease; await pumps; notify remote endpoint. This guarantees idempotent signaling and exactly-once cleanup.

## LiveKit transport

The production `livekit-room` adapter validates every accepted descriptor before loading the native SDK. It joins the room with auto-subscription, publishes one local microphone track, and exposes every subscribed remote microphone track as an independently attributed audio source. LiveKit is normalized at the adapter boundary to signed 16-bit little-endian PCM, 48 kHz, mono, with 20 ms incoming frames where supported. Provider-specific resampling belongs in the model bridge, not this transport.

## Semantic updates, tools, and replay

The lease's bootstrap watermark and ordered update iterable remove the snapshot/subscription race. Accepted notifications are canonical before forwarding and preserve stable event IDs, source metadata, monotonic update sequences, and explicit response policy. Pending updates are bounded; overflow revokes the lease instead of dropping canonical input.

OpenAI can request tools, but Klex remains the authority. The adapter emits a provider-neutral tool request. The coordinator commits the call to canonical history, then invokes `InteractionLease.executeTool()`, which is schema-validating, timed, cancellable, and execution-ID-deduplicated. It commits the result before sending provider output.

Finalized transcripts become ordinary canonical turn commits. Partial deltas are not promoted to turns. Providers without authoritative turn-completion events may commit bounded, explicitly approximate transcript groups as `data-context` with speaker and timeline metadata, never as finalized turns.

One bounded provider reconnect grace window is available. A replacement connection is configured, canonical history is reseeded, and unacknowledged updates and tool results are replayed in original order. Stable update, transcript, and execution IDs prevent duplicate commits and side effects.

## OpenAI Realtime model session

`openai-realtime` preserves three independent planes: MCP (control/lifecycle), LiveKit (caller media), and a server-to-server WebSocket (model inference). The WebSocket carries provider control events and 24 kHz mono PCM16.

The processor accepts multiple concurrent attributed sources and attaches them to a processor-owned PCM mixer. The mixer maintains bounded per-source buffers, assembles arbitrary chunks into 20 ms playout quanta, and combines overlapping samples with saturating PCM16 addition. It emits one 48 kHz mono stream for OpenAI's single logical input.

The mixed stream is converted from 48 kHz to OpenAI's 24 kHz input, and response audio is converted back. Both conversions use a stateful low-pass streaming converter. Provider VAD creates responses and reports speech interruption; interruption cancels and truncates the active response and discards buffered assistant audio.

Realtime availability is derived from `modelSelection.voice.sts`. Each candidate must explicitly declare `capabilities.voice.sts: true`. An empty STS selection disables Realtime Media capability advertisement.

## OpenAI GPT-Live model session

Maintained `gpt-live-1` metadata selects the separate `openai-live` adapter; `gpt-realtime-*` models continue to select `openai-realtime`. GPT-Live receives full-duplex audio and natural voice instructions, while its configured Responses backend receives bounded canonical startup context, Klex instructions, and tool descriptors.

All realtime adapters append a shared live-call visibility policy without changing the prepared context or text-turn instructions. The caller hears spoken answers directly; chat/MCP messages are only for explicitly requested posts or messaging actions, not duplicate answers or acknowledgements. GPT-Live applies this policy to both its speaking frontend and Responses delegation backend, including it in both instruction token budgets.

Responses delegation stays provider-driven. The adapter correlates the outer delegation ID, nested response ID, and stable function `call_id`. Only completed function-call items become provider-neutral tool events. The coordinator remains the sole authority for validation and execution.

GPT-Live transcript deltas have timeline intervals but no authoritative turn boundary. Exact fragments are grouped deterministically and committed as approximate context with speaker and interval metadata, never as finalized turns. Full-duplex overlap is retained.

Usage snapshots are cumulative. One replacement connection is permitted only when no delegated operation is ambiguous; a loss during tool work, a second loss, or an exhausted timeout fails closed without replaying side effects.

## Gemini Live model session

`gemini-live` speaks `BidiGenerateContent` over one raw WebSocket per connection. Google resets Live connections roughly every ten minutes, and without compression ends audio sessions after 15 minutes and audio-video sessions after 2. The adapter therefore carries one provider session across many connections, behind the unchanged `RealtimeModelSession` contract.

Every setup sends `contextWindowCompression` as a sliding window that triggers at 75% of the model's context size and trims to 50%. The system instruction always survives compression; seeded history and early turns may not. Every setup also sends `sessionResumption`, and the adapter keeps the newest handle from each resumable `sessionResumptionUpdate`. Client input sent after that handle is kept as unconfirmed, because the resumed state may not include it.

A `goAway` schedules a switch. The adapter reconnects at the first resumable point (no model turn or tool call in flight and a handle newer than the last exchanged content) or, at the latest, `goAwayMarginMs` before `timeLeft` runs out. An unexpected close or socket error after startup reconnects the same way, with exponential backoff, a per-outage attempt cap and a grace window. The budget restarts after each successful reconnect. Startup failures still fail the call.

During an outage, mixed input audio is buffered for up to one second (older chunks are dropped), and updates and tool results wait. A resumed connection gets the same setup, including tools and voice. It is not reseeded: unconfirmed input is replayed, including up to five seconds of audio sent after the handle, and tool results whose call belonged to the lost connection are sent as context text instead of a dangling `toolResponse`. A reconnect opens its next socket only after the replaced one has closed, waiting at most one second before terminating it, because Google refuses a resume while the previous client still holds the session. A refusal whose reason says the session is already connected is retried with the same handle under the normal backoff. Otherwise, if a resumed setup is refused with close code 1007 or 1008, or with an error that mentions the handle, or fails twice, the handle is dropped. The next connection is a fresh provider session, seeded with the prepared canonical history plus a bounded log of this call's transcripts, updates and tool exchanges. Audio already received keeps playing across a switch, and an assistant turn cut by a drop is committed as interrupted.

Reconnects emit `klex.realtime.gemini_live.reconnects` (by `reason` and `outcome`: `resumed`, `fresh` or `failed`), `klex.realtime.gemini_live.reconnect.duration` and `klex.realtime.gemini_live.go_aways`, plus `gemini_live.*` span events and `gemini-live` log lines. For manual testing, `KLEX_DEBUG_GEMINI_LIVE_GOAWAY_AFTER_MS` synthesizes a goAway, and `KLEX_DEBUG_GEMINI_LIVE_DROP_AFTER_MS` drops the socket, that many milliseconds after each connection becomes ready.

## Voice selection and auditions

STS references carry optional `voiceId` through resolved provider configuration. A new call resolves the current selection; active model sessions snapshot it, including reconnect setup. OpenAI Realtime emits the selected `audio.output.voice` or its existing `marin` default. Gemini emits `generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` only for an explicit selection. GPT-Live precedence is explicit factory override, persisted voice, then `marin`.

Voice auditions belong to the provider registry, not the conversation/session coordinator. An isolated WebSocket uses the exact selected Live model and voice, no canonical history or tools, and no Live Responses delegation. Realtime/Gemini improvise a short introduction using the current agent name and full soul as reference data. GPT-Live first generates bounded commentary with the first configured chat model, then speaks it in client mode. The full soul is intentionally supplied to the relevant generation provider; other configuration and conversation content are excluded. OpenAI Realtime completes at `response.done`; Gemini at `turnComplete`. GPT-Live uses client-mode commentary and silence-clock input, completing after 750 ms without voiced output even while silent PCM frames continue. Only bounded mono 24-kHz PCM16 is wrapped as WAV. Abort, timeout, malformed/empty audio, and upstream closure terminate resources without retries. Credentialed upstream acceptance is separate from mock protocol verification.

## Observability and data handling

Lifecycle logs correlate `leaseId`, `canonicalSessionId`, `externalMediaSessionId`, and MCP namespace. Observability must never include transcript bodies, tool arguments or results, secrets, credentials, or binary media. Counts, sequence numbers, non-secret tool names, model metadata, and closure classes are sufficient for diagnosis.
