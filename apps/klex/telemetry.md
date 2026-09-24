# Klex telemetry

Telemetry is **off by default** and there is no default endpoint. It is configured only per process through CLI arguments or environment variables; it is not part of `config.json`, the settings UI, or the Admin API. Legacy `telemetry` entries in existing config files are ignored. CLI values take precedence over environment values.

Aggregate product analytics are a separate, on-by-default system with their own opt-out; see [product-analytics.md](./product-analytics.md).

| Setting | CLI | Environment |
| --- | --- | --- |
| OTLP base URL (enables telemetry) | `--telemetry-endpoint <url>` | `KLEX_TELEMETRY_ENDPOINT` |
| Debug telemetry (requires endpoint) | `--telemetry-debug` | `KLEX_TELEMETRY_DEBUG=1` |
| Force off (overrides everything) | `--disable-telemetry` | `KLEX_DISABLE_TELEMETRY=1` |
| Extra OTLP headers (JSON object) | — | `KLEX_TELEMETRY_HEADERS` |

Levels:

- `no` (default): no OTLP logs, traces, or metrics are exported or collected.
- `advanced` (endpoint set): lifecycle, aggregate usage, process metrics, operational span detail, bounded error diagnostics, and identity-bearing per-session metrics for active-session state, history size, tool calls, and last-call token/cache usage, with sanitized WARN-and-above logs plus the discrete event logs below. It excludes AI content and stack traces. Session IDs, names, parent relationships, and tool names make advanced exports sensitive operational data.
- `debug` (endpoint and explicit opt-in): adds all log levels (TRACE and above), full structured logs, and content-enabled tracing. **Debug exports chat content, prompts, tool payloads, and other PII.** All exported log messages are best-effort sanitized for credentials, secrets, and URLs; debug additionally preserves arbitrary structured fields after recursively redacting sensitive field names. Use only with a collector you control. Passing `--telemetry-debug` without an endpoint is a startup error.

While telemetry is active, Klex shows a persistent warning naming the endpoint: a yellow banner in the interactive UI (and a framed notice on stderr in headless mode) for `advanced`, and a red, high-contrast banner for `debug`.

The telemetry identity is a random UUID generated per process. It does not include hostnames, usernames, network addresses, or machine fingerprints. `--reset-telemetry-identity` is accepted as a deprecated no-op.

## Export and shutdown timing

Metrics export every 30 seconds by default. Traces and logs use five-second batch intervals. These are operational choices, not universal OpenTelemetry requirements: the OpenTelemetry JavaScript metrics examples commonly use 60 seconds, while shorter intervals such as 15 seconds are also documented for push-based metrics. Klex uses 30 seconds to reduce short-process loss without creating a request per sample.

Counters and histograms are recorded when events happen and observable metrics are collected at export time; the 30-second interval only controls delivery. Logs and completed spans are batched every five seconds. On shutdown, Klex stops runtime producers, explicitly force-flushes metrics and traces, then disposes providers and logs. The default shutdown budget is 15 seconds, configurable with `KLEX_SHUTDOWN_TIMEOUT_MS` from 1,000 to 120,000 ms. The budget must exceed the exporter timeout on deployments with slow or distant backends.

Advanced and debug also emit structured logs (INFO, exported despite the WARN threshold at advanced) for every session state transition, lifecycle event, inbox change, retry, completed tool call, and completed model call. Use these discrete events for timelines and event lists. Do not infer exact transition times from 30-second gauge samples.

## Grafana state-transition timeline

Create a dashboard variable named `session` using the Loki data source and a query-result variable. The following query returns sessions that emitted a transition during the selected dashboard range:

```logql
sum by (klex_session_id) (
  count_over_time(
    {service_name="klex"}
      | event_name="session.state_changed"
    [$__range]
  )
)
```

Set the variable regex to `/klex_session_id="([^"]+)"/`. Grafana Loki normalizes dots in OTLP attribute names to underscores, so source attribute `klex.session.id` is queried as `klex_session_id`. If your Collector promotes `service.name` under a different Loki label, replace `service_name` with that label.

Add a **State timeline** panel with the Loki data source. Select **Range** rather than **Instant**, use **Logs** as the query type, and use:

```logql
{service_name="klex"}
  | event_name="session.state_changed"
  | klex_session_id="$session"
  | line_format "{{.klex_session_state_value}}"
```

Apply these panel transformations in order:

1. **Convert field type**: convert `Line` to number. The Loki `Time` field must remain unchanged.
2. **Organize fields by name**: keep `Time` and `Line`, hide unrelated metadata, and rename `Line` to `State`.
3. If required by the installed Grafana version, add **Prepare time series** with **Multi-frame time series**.
4. Select **State timeline** visualization and enable **Connect null values: Always** so each event's value persists until the next transition.

Configure value mappings: `0 = Idle`, `1 = Working`, `2 = Retrying`, `3 = Leased`, `4 = Success`, and `5 = Terminated`. Use exact-value color mappings for stable colors. Keep the query as a logs/table query; wrapping it in `last_over_time` or another range aggregation reintroduces time buckets and can hide short transitions. Registration emits an initial state event, so the timeline has a defined starting value whenever the session is registered inside the selected range.

For a transition table alongside the graph, remove `line_format` and keep timestamp, `klex_session_state_from`, `klex_session_state_to`, `klex_session_name`, and `klex_session_id`. Sort ascending by timestamp. These are Loki's normalized forms of the dotted OTLP attributes. This table remains the authoritative exact sequence if two transitions share the same rendered pixel in the timeline.

## Local development and deployments

For development builds, CI environments, and deployments that require a local telemetry backend, we recommend the [`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm) Docker container. It provides a local OpenTelemetry Collector with Grafana, Loki, Tempo, and Prometheus-compatible storage, so logs, traces, and metrics can be inspected without sending them to Grafana Cloud.

Start it with the published image and expose the OTLP HTTP and Grafana ports:

```bash
docker run --rm --name klex-otel-lgtm \
  -p 3000:3000 \
  -p 4318:4318 \
  -p 4317:4317 \
  grafana/otel-lgtm:latest
```

The container's Grafana UI is available at `http://localhost:3000`. For a deployment, keep the container on the private network and put it behind an authenticated HTTPS reverse proxy. Klex requires telemetry endpoints to use HTTPS in deployments. For local development only, plain HTTP is allowed for `localhost`, `127.0.0.1`, and `::1`; do not use the container's plain HTTP listener outside loopback. Set the proxy URL with `KLEX_TELEMETRY_ENDPOINT` or `--telemetry-endpoint`; Klex appends `/v1/logs`, `/v1/traces`, and `/v1/metrics` for the OTLP HTTP exporters.

Treat the local LGTM instance as sensitive operational data. Apply the same retention, access-control, and debug-mode rules as any other telemetry backend, and use `no` telemetry when a build or deployment must not export telemetry at all.

Telemetry collection is not a legal privacy guarantee. Product documentation, user consent and disclosure, Grafana Cloud retention/access controls, processor agreements, and jurisdiction-specific requirements must be handled operationally.
