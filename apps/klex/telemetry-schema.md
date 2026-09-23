# Remote telemetry schema

Basic and advanced structured log fields use an allowlist, while complete free-form log messages are forwarded after best-effort credential, secret, and URL sanitization. Debug preserves arbitrary structured log fields after recursively redacting sensitive field names. Debug is an explicit startup override, is not persisted, and lasts for the lifetime of the process.

Every production runtime log uses the same OTLP shape: the stable human-readable message is the log body, searchable data is emitted as flat attributes, `event.name` identifies the event, and `logger.name` identifies the originating runtime module. Telemetry plumbing does not replace the origin with implementation names such as `telemetry-recorder`: session, tool, retry, inbox, and lifecycle events retain `chat-session`, while model-call events retain `model-call-logger`. Known application fields use the dotted names below; unknown camel-case fields are normalized to snake case. Compatibility aliases are not exported. Grafana Loki normalizes dots in OTLP attribute names to underscores at query time—for example, `event.name` becomes `event_name` and `klex.session.id` becomes `klex_session_id`.

## Resource attributes

- `service.name`: `klex`
- `service.namespace`: `stagewise`
- `service.version`: application version, when available
- `service.instance.id`: random installation-scoped UUID
- `host.arch`: normalized host architecture
- `os.type`: normalized operating-system type
- `os.version`: normalized operating-system version
- `process.runtime.name`: `nodejs`
- `process.runtime.version`: Node.js version

Trace, metric, and log resources additionally carry level-gated identity attributes. They are evaluated at export time, so runtime level changes and a later cloud enrollment take effect without a restart:

- `klex.cloud.client_id` (basic, advanced, debug): opaque, server-assigned Klex Cloud client id; absent while the agent is not enrolled
- `klex.agent.name` (advanced, debug): configured agent `officialName`, captured at startup (trimmed, at most 128 characters)
- `klex.agent.data_dir` (debug only): absolute path of the agent data directory

`service.instance.id` is stored in the agent's config and is therefore already unique per agent directory at every level; use it as the stable join key and the identity attributes as human-readable labels.

Traces are exported only at advanced and debug. GenAI spans (`generate_content`, `execute_tool`) carry `gen_ai.agent.name` (the configured agent name, or `extension:{identifier}` for extension-initiated generations) and, when enrolled, `gen_ai.agent.id` (the cloud client id). Because traces are never exported at basic, `gen_ai.agent.name` is advanced/debug only. Advanced spans carry GenAI metadata (operation, provider, request/response model, finish reasons, token usage including cache read/creation tokens and cache ratios) but never prompt, output, system instruction, tool argument/result content, or free-text error messages. Debug spans may additionally carry that content; credential-bearing attribute names are dropped at every level.

Basic allowlisted exports contain no hostname, username, home directory, IP address, MAC address, API credential, agent name, session ID, or conversation ID; the opaque cloud client id is the only identity attribute at basic. Advanced metrics intentionally include session IDs, names, kinds, parent relationships, runtime state, history sizes, tool names, and last-call token/cache state for per-session operations dashboards. Debug includes the same per-session metrics and may additionally include conversation identifiers and AI request/output content in spans. Operators must treat advanced and debug exports as sensitive operational data.

## Discrete event logs

Advanced and debug emit one structured log record for each discrete runtime event. These records are not sampled and preserve event order through their timestamps and log-record sequence. They complement sampled gauges; dashboards that need an exact transition timeline must use these logs rather than `klex.session.runtime_state`.

| `event.name` | Fields |
| --- | --- |
| `session.state_changed` | `klex.session.*`, `klex.session.state.from`, `klex.session.state.to`, `klex.session.state.value` |
| `session.lifecycle_changed` | `klex.session.*`, `klex.session.lifecycle.event` |
| `session.inbox_changed` | `klex.session.*`, signed `delta` |
| `operation.retried` | `klex.session.*`, `operation.name`, `klex.retry.reason` |
| `tool.call_completed` | `klex.session.*`, `gen_ai.tool.name`, `event.outcome`, optional `duration_ms` and `error.type` |
| `model.call_completed` | session identity when available, `operation.name`, provider/source/outcome, `gen_ai.usage.*`, optional duration, TTFT, finish reason, and `error.type` |

`klex.session.state.value` uses `0` for idle, `1` for working, `2` for retrying, `3` for leased, `4` for success, and `5` for terminated. Registration emits an initial transition from `unregistered` to the current runtime state. Event logs include metadata only; they never include prompts, model responses, or tool payloads.

## Metrics

Metrics are gated synchronously by the effective telemetry level. `no` performs no sampling, recording, observing, or export; disabling telemetry clears transient activity measurements, and enabling telemetry rehydrates activity gauges from current O(1) lease, queue, and realtime-session state without recording disabled-period events. CPU and RSS are sampled every 5 seconds and exported every 30 seconds by default. Filesystem size is sampled every 60 seconds.

Every enabled level preserves standard GenAI operation and normalized provider dimensions. Token usage follows the OTel GenAI per-type counters (`gen_ai.client.inference.usage.*`), including cache read/write, at every enabled level. Operation duration includes bounded `klex.outcome` and, on failure, the closed-enum `error.type` at basic and above. Advanced and debug additionally include bounded `klex.call.source` and per-session metrics. Debug may include additional tracing detail but uses the same per-session metric schema as advanced.

Only observable gauges carry the unbounded `klex.session.id` / `klex.session.parent.id`; terminal sessions are pruned from them after a short retention window. Counters and histograms use the bounded role attributes `klex.session.name`, `klex.session.kind`, and `klex.session.extension` so their series do not grow per session.

| Name | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `process.memory.usage` | Observable up-down counter | `By` | none |
| `process.cpu.utilization` | Observable gauge | `1` | `cpu.mode`: `user` or `system` |
| `process.uptime` | Observable gauge | `s` | none |
| `klex.data_directory.size` | Observable gauge | `By` | none |
| `klex.process.memory.rss` | Histogram | `By` | none |
| `klex.process.cpu.utilization.distribution` | Histogram | `1` | `cpu.mode`: `user` or `system` |
| `gen_ai.client.inference.usage.input_tokens` | Counter | `{token}` | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.token.modality` |
| `gen_ai.client.inference.usage.output_tokens` | Counter | `{token}` | same as input tokens |
| `gen_ai.client.inference.usage.cache_read.input_tokens` | Counter | `{token}` | same as input tokens; subset of input |
| `gen_ai.client.inference.usage.cache_write.input_tokens` | Counter | `{token}` | same as input tokens; subset of input |
| `gen_ai.client.inference.operation.input_tokens` | Histogram | `{token}` | `gen_ai.operation.name`, `gen_ai.provider.name`; successful calls only |
| `gen_ai.client.inference.operation.output_tokens` | Histogram | `{token}` | `gen_ai.operation.name`, `gen_ai.provider.name`; successful calls only |
| `gen_ai.client.operation.time_to_first_chunk` | Histogram | `s` | `gen_ai.operation.name`, `gen_ai.provider.name` |
| `gen_ai.client.operation.duration` | Histogram | `s` | standard GenAI dimensions, `klex.outcome`, and normalized `error.type` on failure; advanced adds `klex.call.source` |
| `klex.interaction.lease.active` | Observable gauge | `{lease}` | none |
| `klex.interaction.queue.depth` | Observable gauge | `{update}` | none |
| `klex.interaction.queue.overflow` | Counter | `{event}` | none |
| `klex.realtime.session.active` | Observable gauge | `{session}` | none |
| `klex.session.active` | Observable gauge | `1` | advanced/debug: `1` while the session runtime state is `working`, otherwise `0`; session identity attributes |
| `klex.session.runtime_state` | Observable gauge | `1` | advanced/debug: session identity and `klex.session.runtime.state` |
| `klex.session.history.length` | Observable gauge | `{message}` | advanced/debug: session identity attributes |
| `klex.session.history.transformed_length` | Observable gauge | `{message}` | advanced/debug: session identity attributes |
| `klex.session.last_call.tokens` | Observable gauge | `{token}` | advanced/debug: session identity, `klex.call.source`, and `klex.token.type` (`input`/`cache_read`/`cache_write`) |
| `klex.session.last_call.cache_read_ratio` | Observable gauge | `1` | advanced/debug: session identity and `klex.call.source` |
| `klex.session.state.changes` | Counter | `{transition}` | advanced/debug: session role and bounded from/to states |
| `klex.session.inbox.changes` | Up-down counter | `{item}` | advanced/debug: session role; additions are positive and removals negative on the same series |
| `klex.session.lifecycle` | Counter | `{event}` | advanced/debug: session role and lifecycle event |
| `gen_ai.execute_tool.duration` | Histogram | `s` | advanced/debug: session role, bounded `gen_ai.tool.name`, `gen_ai.tool.type`, and on failure `error.type` (tool error code or `_OTHER`) |
| `klex.operation.retries` | Counter | `{retry}` | advanced/debug: operation, retry reason, and session kind |

CPU and RSS histograms preserve distributions of 5-second samples. Token boundaries are `1` through `67,108,864`; duration boundaries range from `0.01` to `81.92` seconds; CPU boundaries range from `0.01` through `1`; RSS boundaries range from `64 MiB` through `4 GiB`. Basic metrics use bounded, low-cardinality dimensions and contain no model prompts, completions, tool payloads, session IDs, or arbitrary user-controlled labels. Advanced/debug per-session metrics intentionally trade cardinality and identifiability for operational visibility. Session and tool attributes are length-bounded; tool names use a process-local 256-value cardinality cap with overflow reported as `_other`. Gauge session identity attributes are `klex.session.id`, `klex.session.name`, `klex.session.kind`, optional `klex.session.extension`, and optional `klex.session.parent.id`; counter and histogram session role attributes omit the two ids. Call and error counts are derived from histogram counts (`gen_ai.client.operation.duration`, `gen_ai.execute_tool.duration`) filtered by `error.type`.

## Model-call semantics

Every terminal model call is counted once by `callId`, including success, error, and abort outcomes. Text-generation calls use `gen_ai.operation.name = generate_content`; provider identifiers are normalized to OTel-compatible values. `chat` and `extension` are represented by `klex.call.source` at advanced/debug. Per-session last-call gauges update on each terminal model call. The `input` token type is the provider-reported token count for the final transformed request. `cache_read` and `cache_write` are subsets of `input`, not additional tokens: never add the cache counters to the input counter. Uncached input is `input_tokens - cache_read.input_tokens - cache_write.input_tokens`. Token modality is not reported by providers today and is exported as `unknown`. `cache_read_ratio` is cache-read tokens divided by input tokens and is omitted when the denominator is zero.

## Session traces

Every chat session owns exactly one trace whose root span is named `session {name}`, where `name` is the stable, low-cardinality session role: `session main`, `session god`, and extension-owned child sessions such as `session consult`, `session memory-retrieval`, and `session episodic-memory-writer`. Per-instance identity is never part of the span name; it lives in the root span attributes `klex.session.id`, `klex.session.name`, `klex.session.kind`, and, for child sessions, `klex.session.extension` and `klex.session.parent.id`. Main and child sessions use this identical scheme.

A child session starts a separate trace. Its root span carries one link (`klex.link.type = parent_session`) to the span that spawned it: the active span of the parent trace (usually the extension's `execute_tool` span), or the parent session root span when nothing is active. That spawning span records a `session.child_created` event with `klex.session.child.id`, `klex.session.child.name`, and `klex.session.child.extension`.

Inside a session trace, operations nest as `turn` → `step` → `generate_content` / `execute_tool {tool}`. Extension-initiated generations appear as `extension.generate_text` (with `klex.extension.id`) wrapping their per-model `generate_content` spans. Tools called through realtime interaction leases run under the session root span, so no operation inside a session produces an orphan trace. Realtime transports keep their own `gpt_live.session` / `gemini_live.session` traces.

## Debug

Debug mode enables model content on `generate_content` spans. Inputs are exported as `gen_ai.system_instructions`, `gen_ai.input.messages`, and `gen_ai.tool.definitions`; outputs are exported as `gen_ai.output.messages`. Advanced mode always removes these attributes. Debug mode may include AI request inputs and outputs and more detailed tracing. Credentials and sensitive field names are redacted by the logger transport on a best-effort basis, but free-form messages and arbitrary debug fields can still contain private data. Operators must treat debug exports as sensitive and disable debug when troubleshooting is complete.
