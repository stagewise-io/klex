# Remote telemetry schema

Basic and advanced exports use an allowlist. Arbitrary logger fields and free-form log messages are not forwarded. Debug is an explicit startup override, is not persisted, and lasts for the lifetime of the process.

## Resource attributes

- `service.name`: `klex`
- `service.namespace`: `stagewise`
- `service.version`: application version, when available
- `service.instance.id`: random installation-scoped UUID

No hostname, username, home directory, IP address, MAC address, API credential, session ID, or conversation ID is exported.

## Metrics

Metrics are gated synchronously by the effective telemetry level. `no` performs no sampling, recording, observing, or export; disabling telemetry clears transient activity measurements, and enabling telemetry rehydrates activity gauges from current O(1) lease, queue, and realtime-session state without recording disabled-period events. CPU and RSS are sampled every 5 seconds and exported every 60 seconds by default. Filesystem size is sampled every 60 seconds.

Every enabled level preserves standard GenAI operation and normalized provider dimensions. Token metrics additionally include `gen_ai.token.type`, and operation duration includes bounded `klex.outcome` at basic and above. Advanced and debug additionally include bounded `klex.call.source` and normalized `error.type`; cache token metrics are advanced/debug only and use bounded `klex.cache.type`. Debug may include additional tracing detail, but does not relax metric privacy or cardinality policy.

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

CPU and RSS histograms preserve distributions of 5-second samples. Token boundaries are `1` through `67,108,864`; duration boundaries range from `0.01` to `81.92` seconds; CPU boundaries range from `0.01` through `1`; RSS boundaries range from `64 MiB` through `4 GiB`. Metrics use bounded, low-cardinality dimensions and contain no model prompts, completions, tool payloads, session IDs, or arbitrary user-controlled labels.

## Model-call semantics

Every terminal model call is counted once by `callId`, including success, error, and abort outcomes. Text-generation calls use `gen_ai.operation.name = generate_content`; provider identifiers are normalized to OTel-compatible values. `chat` and `extension` are represented only by `klex.call.source` at advanced level.

## Debug

Debug mode may include AI request inputs and outputs and more detailed tracing. Credentials remain redacted by the logger transport, but operators must treat debug exports as sensitive and disable debug when troubleshooting is complete.
