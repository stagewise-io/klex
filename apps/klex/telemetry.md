# Klex telemetry

Klex supports three configurable remote telemetry levels plus a separate process-only debug override. Telemetry is sent to `https://telemetry.klex.bot` by default; set `KLEX_TELEMETRY_ENDPOINT` or pass `--telemetry-endpoint` to override the OTLP base URL. CLI values take precedence over environment values.

Configurable levels:

- `no`: no OTLP logs, traces, or metrics are exported or collected.
- `basic`: lifecycle, aggregate usage, sanitized warnings/errors, and process metrics. Prompts, responses, tool payloads, session identifiers, and arbitrary fields are excluded.
- `advanced`: more operational span detail and bounded error diagnostics, still without AI content or stack traces.

Debug is a temporary startup override and is never persisted or exposed through the settings API. Use `--telemetry-debug` or `KLEX_TELEMETRY_DEBUG=1` to enable all log levels and content-enabled tracing for the process lifetime. Debug still applies the OTLP privacy sanitizer; free-form log bodies and non-allowlisted fields are not exported. Debug tracing should be disabled when no longer needed.

The installation-scoped telemetry identity is a random UUID stored in the agent config. It does not include hostnames, usernames, network addresses, or machine fingerprints. Rotate it with `--reset-telemetry-identity`.

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
