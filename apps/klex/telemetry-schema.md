# Remote telemetry schema

Basic and advanced exports use an allowlist. Arbitrary logger fields and free-form log messages are not forwarded. Debug is an explicit startup override, is not persisted, and lasts for the lifetime of the process.

## Resource attributes

- `service.name`: `klex`
- `service.namespace`: `stagewise`
- `service.version`: application version, when available
- `service.instance.id`: random installation-scoped UUID

Basic allowlisted exports contain no hostname, username, home directory, IP address, MAC address, API credential, session ID, or conversation ID. Advanced metrics intentionally include session IDs, names, kinds, parent relationships, runtime state, history sizes, tool names, and last-call token/cache state for per-session operations dashboards. Debug includes the same per-session metrics and may additionally include conversation identifiers and AI request/output content in spans. Operators must treat advanced and debug exports as sensitive operational data.

## Metrics

Metrics are gated synchronously by the effective telemetry level. `no` performs no sampling, recording, observing, or export; disabling telemetry clears transient activity measurements, and enabling telemetry rehydrates activity gauges from current O(1) lease, queue, and realtime-session state without recording disabled-period events. CPU and RSS are sampled every 5 seconds and exported every 60 seconds by default. Filesystem size is sampled every 60 seconds.

Every enabled level preserves standard GenAI operation and normalized provider dimensions. Token metrics additionally include `gen_ai.token.type`, and operation duration includes bounded `klex.outcome` at basic and above. Advanced and debug additionally include bounded `klex.call.source`, normalized `error.type`, aggregate cache-token histograms, and identity-bearing per-session metrics. Debug may include additional tracing detail but uses the same per-session metric schema as advanced.

| Name | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `process.memory.usage` | Observable up-down counter | `By` | none |
| `process.cpu.utilization` | Observable gauge | `1` | `cpu.mode`: `user` or `system` |
| `process.uptime` | Observable gauge | `s` | none |
| `klex.data_directory.size` | Observable gauge | `By` | none |
| `klex.process.memory.rss` | Histogram | `By` | none |
| `klex.process.cpu.utilization.distribution` | Histogram | `1` | `cpu.mode`: `user` or `system` |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.token.type` |
| `gen_ai.client.operation.time_to_first_chunk` | Histogram | `s` | `gen_ai.operation.name`, `gen_ai.provider.name` |
| `gen_ai.client.operation.duration` | Histogram | `s` | standard GenAI dimensions and `klex.outcome`; advanced adds `klex.call.source` and normalized `error.type` |
| `klex.gen_ai.client.cache.token.usage` | Histogram | `{token}` | advanced/debug only: standard GenAI dimensions and `klex.cache.type` (`read`/`write`) |
| `klex.interaction.lease.active` | Observable gauge | `{lease}` | none |
| `klex.interaction.queue.depth` | Observable gauge | `{update}` | none |
| `klex.interaction.queue.overflow` | Counter | `{event}` | none |
| `klex.realtime.session.active` | Observable gauge | `{session}` | none |
| `klex.session.active` | Observable gauge | `1` | advanced/debug: session identity attributes |
| `klex.session.runtime_state` | Observable gauge | `1` | advanced/debug: session identity and `klex.session.runtime.state` |
| `klex.session.history.length` | Observable gauge | `{message}` | advanced/debug: session identity attributes |
| `klex.session.history.transformed_length` | Observable gauge | `{message}` | advanced/debug: session identity attributes |
| `klex.session.last_call.input_tokens` | Observable gauge | `{token}` | advanced/debug: session identity and `klex.call.source` |
| `klex.session.last_call.cache_read_tokens` | Observable gauge | `{token}` | advanced/debug: session identity and `klex.call.source` |
| `klex.session.last_call.cache_write_tokens` | Observable gauge | `{token}` | advanced/debug: session identity and `klex.call.source` |
| `klex.session.last_call.cache_read_ratio` | Observable gauge | `1` | advanced/debug: session identity and `klex.call.source` |
| `klex.session.tool.calls` | Counter | `{call}` | advanced/debug: session identity, tool name, and outcome |

CPU and RSS histograms preserve distributions of 5-second samples. Token boundaries are `1` through `67,108,864`; duration boundaries range from `0.01` to `81.92` seconds; CPU boundaries range from `0.01` through `1`; RSS boundaries range from `64 MiB` through `4 GiB`. Basic metrics use bounded, low-cardinality dimensions and contain no model prompts, completions, tool payloads, session IDs, or arbitrary user-controlled labels. Advanced/debug per-session metrics intentionally trade cardinality and identifiability for operational visibility. Their session identity attributes are `klex.session.id`, `klex.session.name`, `klex.session.kind`, and optional `klex.session.parent.id`.

## Model-call semantics

Every terminal model call is counted once by `callId`, including success, error, and abort outcomes. Text-generation calls use `gen_ai.operation.name = generate_content`; provider identifiers are normalized to OTel-compatible values. `chat` and `extension` are represented by `klex.call.source` at advanced/debug. Per-session last-call gauges update on each terminal model call. `input_tokens` is the provider-reported token count for the final transformed request. `cache_read_ratio` is cache-read tokens divided by input tokens and is omitted when the denominator is zero.

## Debug

Debug mode may include AI request inputs and outputs and more detailed tracing. Credentials remain redacted by the logger transport, but operators must treat debug exports as sensitive and disable debug when troubleshooting is complete.
