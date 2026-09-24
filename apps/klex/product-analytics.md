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

Klex sends four event types to PostHog EU (`https://eu.i.posthog.com`). All closed property sets are defined and strictly validated in `src/product-analytics/schema.ts`.

- `klex_agent_started`: at most once per process, once an agent directory has been opened (locked, migrated, config loaded). That is headless mode with a valid `--data-dir`, or interactive mode after the user picks an agent. Quitting the picker, a missing `--data-dir` in headless mode, or a directory that fails to open sends none. It carries only the shared properties below. It is sent in the background and never delays startup. Comparing started with shutdown counts shows how many processes end without a graceful shutdown.
- `klex_usage_window`: one per window. A window ends every 2 hours and at graceful shutdown. It adds aggregate counts and resource readings for that window. Windows cover agent runtime only: the first window starts at `klex_agent_started`, so every window follows the start event of the same process (same `distinct_id`). A process that never opens an agent (picker quit, failed startup) sends no window; it may still send enrollment events.
- `klex_enrollment_started` and `klex_enrollment_finished`: one pair per cloud enrollment flow (below).

Shared by all events:

- `klex_version`, `telemetry_enabled_at_start`, `cloud_enabled`, `os_platform`, `os_arch`, `os_release`, `node_version`.
- `deployment`: `self_hosted`, `cloud`, or `other`, from `--deployment <name>`, else `KLEX_DEPLOYMENT`. The flag wins even when blank. Unset or blank means `self_hosted`; any unrecognised value is sent as `other`, so free-form labels never reach PostHog. Hosting launchers such as Klex Cloud images set `KLEX_DEPLOYMENT=cloud`. Whoever launches the process controls it, so it is a label, not proof of where the process runs. It is independent of `cloud_enabled` and `cloud_enrolled`, which describe the cloud connection, not the host.

Every CLI- or env-controlled property (`deployment`, `telemetry_enabled_at_start`, `cloud_enabled`, and whether analytics run at all) is taken from the resolved CLI options, where a flag always takes precedence over its env var. Analytics never re-read the environment, so the reported value always matches what the process uses.

Only in `klex_usage_window`:

- Window and state: `window_reason` (`interval` / `shutdown`), `window_duration_s`, `cloud_enrolled`, `mcp_connected_count`. The last two are read when the event is built and are `null` in the shutdown window (MCP and cloud are already closed) or when unreadable.
- Sessions: `sessions_active`, `sessions_started`, `sessions_ended`, `turns_total`, `steps_total`, `turns_per_session_max`, `steps_per_session_max`. A session is one chat session (default, god, or child). Counts are per session within the window, not per session lifetime.
- Runtime notes: `os_platform` is `darwin`, `linux`, `win32`, …. `os_release` is the kernel major only (`24`, `6`); on Windows it is `major.minor.build` (`10.0.22631`), because Windows 10 and 11 both report `10.0`.
- Resources: `process_uptime_s`, `cpu_avg_pct` (average over the window, percent of one core, can exceed 100), `memory_rss_mb` and `memory_heap_used_mb` (at event time), `memory_rss_peak_mb` (peak since process start). These come from Node's process counters when the event is built. There is no background sampler, so short spikes inside a window show up only in the peak RSS.

### Cloud enrollment

A flow starts when Klex asks for an enrollment code or sends one it was given. `enrollment_method` says where:

| Method | Starts when | Ends when |
| --- | --- | --- |
| `agent_picker` | The picker shows the code prompt for an unenrolled agent | Enrolled; Esc, quit or switching agent (`aborted`) |
| `cloud_screen` | The user opens the code input on the Cloud screen | Enrolled; a rejected code (`failed`, the screen returns to its overview); Back or leaving the screen (`aborted`) |
| `token` | A `--cloud-enroll-token` / `KLEX_CLOUD_ENROLLMENT_TOKEN` request is sent (only when not already enrolled) | Enrolled or `failed` |

`klex_enrollment_finished` adds `enrollment_outcome` (`enrolled`, `failed`, `aborted`), `failed_attempts` (rejected codes within the flow, including a final one; the picker allows retries), and `duration_s`. Flows still open at graceful shutdown finish as `aborted` before the last window is sent. Codes, tokens, error messages, and cloud or client IDs are never sent.

Klex never sends session, agent, cloud, or client IDs, key IDs, names, paths, model or provider names, prompts, content, tool names, hostnames, usernames, full OS version strings, or disk usage. If an event fails schema validation, it is dropped rather than sent partially.

## Identity

Each process generates a random `distinctId`. It lives in memory only and is never written to disk, so PostHog "unique users" counts process runs, not installs or people. Every event sets `$process_person_profile: false` and disables GeoIP. The PostHog SDK also adds its library name and version (`$lib`, `$lib_version`).

The HTTP request itself reveals the sender's IP address. The PostHog project must have **Discard client IP data** enabled; that setting is the only thing that stops PostHog from storing it.

## Delivery and loss

- Events are sent with `captureImmediate`, bypassing the SDK queue. Delivery is best effort: the SDK retries a request twice, after which that window is lost. There is no local outbox.
- Graceful shutdown (SIGINT, SIGTERM, SIGHUP, self-update restart) sends the final window within a 3 s budget inside `KLEX_SHUTDOWN_TIMEOUT_MS`. Anything unsent at the deadline is dropped.
- A crash, SIGKILL, OOM kill, or power loss loses the current window (up to 2 h of counts) and leaves any open enrollment flow without a finished event. The start event has already been sent by then.
- Analytics never block or crash startup. If the client cannot be created, analytics stay off for that process.

## Debug logs

With `--verbose`, the `product-analytics` module logs at debug level:

| Message | Fields |
| --- | --- |
| `Product analytics disabled` | `reason`: `opted-out` or `no-key` (no key compiled in) |
| `Product analytics enabled` | `host`, `key` (first 8 characters), `deployment` |
| `Product analytics event sent` | `event`, `reason` (window events) |
| `Product analytics send failed` | `event`, `error` (SDK message with HTTP status) |
| `Product analytics event dropped by schema validation` | `event`, `issues` (property names only) |

`event sent` means the SDK reported no error for the request. It does not prove that PostHog stored the event, because whether PostHog rejects an unknown project key with an error status has not been verified. The final check is the event appearing in the project.

`--help`, `--version`, `--verify-native`, and cancelling the interactive agent picker never start analytics.

## Builds

The PostHog project key is compiled in by `build.ts` from `POSTHOG_KEY`. The optional `POSTHOG_HOST` overrides the endpoint (default `https://eu.i.posthog.com`). Release and nightly workflows pass both from the `POSTHOG_KEY` and `POSTHOG_HOST` repository variables. The project key is public by design, since it ships inside the binary, so it is a variable rather than a secret. Builds without a key, including `tsx`, vitest, CI test builds, and forks, have analytics permanently inert.
