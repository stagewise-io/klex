# Events extension compatibility notes

Tracks `io.modelcontextprotocol/events` as specified by SEP-3415.

- Source: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415
- Re-checked 2026-11-12 via the GitHub API: PR #3415 is open and unmerged, head `f77a5fe31b91c052dbfc2a37add98b9e84662b34` (updated 2026-11-11). `modelcontextprotocol/ext-events` latest commit is `d5316be214be2e76e51462069c1d67e00a5a7619` (2026-10-09).
- Caveat: the local text snapshot predates this check and was not stamped with a SHA, so it may differ from `f77a5fe`. Diff it before treating the types as matching.
- Status caveat: the SEP file header says "Accepted", but the PR was still open at retrieval. Treat the wire format as unstable.
- Requires protocol revision `2026-07-28` or later.

## Implemented in this package

- Methods: `events/list`, `events/poll`, `events/stream`.
- Notifications: `notifications/events/{active,event,heartbeat,error,terminated,list_changed}`.
- Capability negotiation, including the per-request client capability in `_meta`.
- Absent `cursor` is equivalent to `null`, in both directions.

## Deliberately not implemented

- Webhook delivery (`events/subscribe`, `events/unsubscribe`, signatures, endpoint verification). Needs a public receiver and secret storage.
- Server-side facade.

## Provisional

Error codes `-32023..-32027` are provisional per the SEP. `-32020` (`HeaderMismatch`) comes from SEP-2243. Keep all numeric codes in `src/constants.ts`.

## Deviations

None known. Schemas are not `strict()`, so unknown fields from newer servers are tolerated.
