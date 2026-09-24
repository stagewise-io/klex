# Klex product analytics

Product analytics are **on by default** in release builds. They are separate from [telemetry](./telemetry.md): different module, different switch, different destination. `--disable-telemetry` does not affect analytics, and `--no-analytics` does not affect telemetry.

## Opt out

| Setting | CLI | Environment |
| --- | --- | --- |
| Turn analytics off | `--no-analytics` | `KLEX_NO_ANALYTICS=1` or `DO_NOT_TRACK=1` |
| Force on (overrides env) | `--analytics` | — |

The CLI wins over the environment. Environment values other than `1` are ignored. There is no config entry, settings UI toggle, or Admin API for analytics.

When analytics are off, Klex creates no PostHog client, starts no timers, and makes no network requests.

## What is sent

Klex sends one `klex_usage_window` event per window to PostHog EU (`https://eu.i.posthog.com`). A window ends every 2 hours and at graceful shutdown. The event holds only aggregate counts for that window. The closed property set is defined and strictly validated in `src/product-analytics/schema.ts`:

- Build and state: `klex_version`, `window_reason` (`interval` / `shutdown`), `window_duration_s`, `telemetry_enabled_at_start`, `cloud_enabled`, `cloud_enrolled`, `mcp_connected_count`. The last two are read when the event is built and are `null` in the shutdown window (MCP and cloud are already closed) or when unreadable.
- Sessions: `sessions_active`, `sessions_started`, `sessions_ended`, `turns_total`, `steps_total`, `turns_per_session_max`, `steps_per_session_max`. A session is one chat session (default, god, or child). Counts are per session within the window, not per session lifetime.
- Runtime: `os_platform` (`darwin`, `linux`, `win32`, …), `os_arch`, `os_release`, `node_version`. `os_release` is the kernel major only (`24`, `6`); on Windows it is `major.minor.build` (`10.0.22631`), because Windows 10 and 11 both report `10.0`.
- Resources: `process_uptime_s`, `cpu_avg_pct` (average over the window, percent of one core, can exceed 100), `memory_rss_mb` and `memory_heap_used_mb` (at event time), `memory_rss_peak_mb` (peak since process start). These come from Node's process counters when the event is built. There is no background sampler, so short spikes inside a window show up only in the peak RSS.

Klex never sends session, agent, cloud, or client IDs, key IDs, names, paths, model or provider names, prompts, content, tool names, hostnames, usernames, full OS version strings, or disk usage. If an event fails schema validation, it is dropped rather than sent partially.

## Identity

Each process generates a random `distinctId`. It lives in memory only and is never written to disk, so PostHog "unique users" counts process runs, not installs or people. Every event sets `$process_person_profile: false` and disables GeoIP. The PostHog SDK also adds its library name and version (`$lib`, `$lib_version`).

The HTTP request itself reveals the sender's IP address. The PostHog project must have **Discard client IP data** enabled; that setting is the only thing that stops PostHog from storing it.

## Delivery and loss

- Events are sent with `captureImmediate`, bypassing the SDK queue. Delivery is best effort: the SDK retries a request twice, after which that window is lost. There is no local outbox.
- Graceful shutdown (SIGINT, SIGTERM, SIGHUP, self-update restart) sends the final window within a 3 s budget inside `KLEX_SHUTDOWN_TIMEOUT_MS`. Anything unsent at the deadline is dropped.
- A crash, SIGKILL, OOM kill, or power loss loses the current window (up to 2 h of counts).
- Analytics never block or crash startup. If the client cannot be created, analytics stay off for that process. Send errors are logged at debug level.

`--help`, `--version`, `--verify-native`, and cancelling the interactive agent picker never start analytics.

## Builds

The PostHog project key is compiled in by `build.ts` from `POSTHOG_KEY`. The optional `POSTHOG_HOST` overrides the endpoint (default `https://eu.i.posthog.com`). Release and nightly workflows pass both from the `POSTHOG_KEY` and `POSTHOG_HOST` repository variables. The project key is public by design, since it ships inside the binary, so it is a variable rather than a secret. Builds without a key, including `tsx`, vitest, CI test builds, and forks, have analytics permanently inert.
