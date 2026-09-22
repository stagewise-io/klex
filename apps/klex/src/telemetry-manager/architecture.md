# Telemetry architecture

Klex remote telemetry has four effective levels. The persisted spelling for disabled telemetry is `no`; operator-facing text may describe it as “off”. Debug is a command-line-only, non-persisted override for the process lifetime. Authentication material is forbidden at every level.

## Level contract

| Concern | `no` | `basic` | `advanced` | `debug` |
| --- | --- | --- | --- | --- |
| Remote export and buffering | None | Enabled | Enabled | Enabled |
| Process sampling | None | CPU/RSS 5 s, filesystem 60 s | Basic plus host capacity | Advanced |
| Metrics | None | Aggregate health, operations, turns, steps, queues | Basic plus model/provider/session/tool/extension identity | Advanced schema |
| Logs | None | Structured WARN+ | Structured INFO+ | Structured DEBUG+ |
| Traces | Non-recording | Coarse failures/operations only | Sanitized detailed topology | Detailed, content-bearing |
| Session/model/tool/extension identifiers | None | None | Allowed | Allowed |
| Prompts, completions, messages, tool arguments/results | None | Never | Never | Explicitly allowed |
| Credentials, auth headers, configured secrets | Never | Never | Never | Never |
| Platform identity | None | Service/runtime resource identity | Basic plus safe OS/architecture inventory metrics | Advanced |

All application-facing recorders gate before allocation or registry mutation. Local model-call persistence is a product data path and remains independent from remote telemetry.

## Components and ownership

```text
persisted config + CLI override
            |
            v
TelemetryManager ----> immutable TelemetryPolicySnapshot
     |                         |
     |                         +--> application recorders gate work
     +--> metrics pipeline     +--> span sampler/processor gates work
     +--> trace pipeline       +--> log transport threshold gates work
     +--> log pipeline
            |
            v
        OTLP/HTTP
```

- **Telemetry policy** owns the effective level and O(1) signal decisions.
- **Telemetry manager** is the only level-transition coordinator.
- **Resource factory** produces identical service and runtime identity for metrics, traces, and logs. Because providers live for the process lifetime, level-dependent OS and architecture inventory is emitted as advanced metrics rather than immutable resource attributes.
- **Signal pipelines** own SDK providers, readers/processors, exporters, timers, and shutdown.
- **Application recorders** accept bounded domain events and never know OTLP endpoints or SDK lifecycle.

Startup applies policy before application modules start. Disabling closes policy gates before exporters. Enabling prepares exporters before opening policy gates. Shutdown stops application ingress, stops samplers, performs bounded final flushes, then disposes signal resources.

## Inventory

| Existing component | Signal/state | Final level | Lifecycle owner |
| --- | --- | --- | --- |
| `TelemetryMetricsModule` process gauges and sample histograms | Metrics | Basic+ | Metrics pipeline |
| Data-directory size sampler | Metric | Basic+ | Metrics pipeline |
| GenAI duration/token/TTFT/cache instruments | Metrics | Basic aggregate; advanced dimensions | Metrics pipeline |
| Lease, queue, overflow, realtime activity | Metrics | Basic+ | Activity adapter/metrics pipeline |
| Session registry and session/tool observations | Metrics | Advanced+ | Session adapter/metrics pipeline |
| Turn/step instrumentation | Metrics | Basic aggregate; advanced identity | Session adapter/metrics pipeline |
| Provider/model inventory | Metrics | Advanced+ | Config adapter/metrics pipeline |
| Session/turn/step/model/tool/realtime spans | Traces | Advanced sanitized; debug content | Tracing pipeline |
| Coarse operation/error spans | Traces | Basic+ | Tracing pipeline |
| tslog OTLP HTTP transport | Logs | Basic+ by threshold | Logging pipeline/root logger |
| CPU/RSS sampler | Timer | Basic+ | Metrics pipeline |
| Filesystem sampler | Timer | Basic+ | Metrics pipeline |
| Session/provider/model/extension registries | Observable state | Advanced+ | Metrics pipeline |

## Attribute classification

| Class | Examples | Policy |
| --- | --- | --- |
| Fixed catalog | operation, outcome, runtime state, provider type | Basic when explicitly approved |
| Bounded runtime value | normalized error type, finish reason | Basic when explicitly approved |
| Installation identifier | `service.instance.id` | All enabled levels |
| Operational identifier | session ID/name, model ID, provider instance, tool/extension name | Advanced/debug only, cardinality bounded |
| Content | prompts, completions, messages, tool arguments/results, exception text | Debug only |
| Credential | API keys, authorization/cookie headers, URL credentials/query secrets | Forbidden at every level |
| Host identity | hostname, username, home path, IP/MAC | Forbidden |

## OpenTelemetry contract

The implementation targets the OpenTelemetry JS packages pinned in `apps/klex/package.json`: API 1.9.0-compatible behavior, SDK 2.9.0, OTLP exporters 0.220.0, and the GenAI semantic conventions implemented by that dependency set. GenAI conventions are experimental; standard names are used only when type, unit, meaning, and dimensions match the pinned contract. Klex-specific instruments and attributes use the `klex.*` namespace.

Process crashes cannot guarantee final in-process delivery. Deployments requiring stronger delivery should send to a local OpenTelemetry Collector with its own queue and retry policy.
