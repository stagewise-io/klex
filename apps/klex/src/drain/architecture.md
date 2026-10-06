# Drain

A drain lets the agent finish its current work before the process goes away. Two triggers use it: an auto-update restart and SIGTERM in `--headless` mode.

## Sequence

1. Stop new work for the rest of the process: `SessionHost.beginDrain()`, `GodMessages.beginDrain()`, `Mcp.pausePushDelivery()`. Events that arrive later stay in the server's pending queue for the next process.
2. Poll until the default session tree and the god session are quiescent, or the budget runs out.
3. Once quiescent, acknowledge the Push Notifications that were handled. After a timeout nothing is acknowledged, so unfinished events are delivered again.
4. The caller runs the normal shutdown (`KLEX_SHUTDOWN_TIMEOUT_MS`).

Step 1 runs once per process. Each request waits with its own budget, so a SIGTERM during an update drain still respects its own deadline.

## Triggers

| Trigger | Budget | Realtime call |
|---------|--------|---------------|
| Auto-update restart | 10 min | Pauses the clock |
| SIGTERM, headless | `KLEX_DRAIN_TIMEOUT_MS` (default 5 min, `0` disables) | Counts as wall-clock time |

SIGTERM uses wall-clock time because the orchestrator sends SIGKILL at its own deadline. A second SIGTERM, or a SIGINT, skips the wait and shuts down at once. A restart requested while a SIGTERM drain is pending is ignored; the process exits.

## Kubernetes

Set `terminationGracePeriodSeconds` above `KLEX_DRAIN_TIMEOUT_MS + KLEX_SHUTDOWN_TIMEOUT_MS` plus a margin. With the defaults (300 s + 15 s) that is about 330 s. A lower grace period still works, but work that is still running at SIGKILL is lost and its events are delivered again.

Don't add a `preStop` hook that sleeps. Klex stops accepting work as soon as it gets SIGTERM, and a sleep only uses up the grace period.
