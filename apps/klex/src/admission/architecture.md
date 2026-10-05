# Admission and pre-teardown quiescence

Composition shares one process-local `AdmissionGate` across the admin application,
MCP, every recursively created chat session, extensions, and realtime coordinator.
It is independent of the updater and does not download, install, replace binaries,
or initiate a restart.

## Maintenance contract

`RuntimeHandle.prepareMaintenance({ graceMs })` atomically cuts off root admission
and waits for admitted work. The default grace is 60,000 ms; callers can override
it per preparation. The result is either an aborted preparation or a private,
instance-owned quiescence lease. Preparation never closes runtime modules.

- New admin requests receive HTTP 503 with `Retry-After: 1` and `retryable: true`.
  Health and introspection remain accessible. Local and Cloud-tunneled requests
  use the same middleware.
- New realtime offers are rejected before acquiring a generation lease or
  accepting remotely. Offers admitted before cutoff, setup, active streams,
  tools, transcripts, and audio pumps remain tracked until natural completion.
- Inbox input holds work leases through the whole chat loop, including deferred
  inputs, model fallback, and backoff. Child startup, extension generation,
  compaction, consult lifetime, interaction leases, and resource operations are
  tracked. Worker RPC callbacks bind the admitting execution's context rather
  than inheriting the worker's startup context. Released asynchronous contexts
  cannot admit new descendants.
- During drain, existing tasks share a budget of 64 new continuations/descendants
  and maximum admission depth two. Existing steps run to their ordinary limits.
  Exhausted turn/retry continuations pause rather than terminate their task.
- Unrelated reminder delivery, memory flush/recovery, MCP reconciliation,
  reconnect, and resource retries defer until reopening. Reminders pause before
  consuming their persisted due time. Deferred callbacks prevent certification;
  they are not a durable ingress queue. At 1,024 deferred callbacks preparation
  aborts and resumes the live runtime instead of growing an unbounded buffer.

At grace expiry, or on uncertain participant safety, maintenance aborts, admission
reopens, and deferred callbacks resume on the **same runtime**. No task cancellation,
remote hangup, transport close, module teardown, or replacement occurs. Failed
callback resumption retains the callback and exposes a diagnostic reason; it
cannot disappear into a successful quiescence result.

Only `closeForMaintenance(lease)` may consume a current quiescence lease for
destructive teardown. It rechecks zero work, no deferred callbacks, participant
safety, and exact lease identity synchronously before closing admission permanently.
Competing preparations, forged or foreign leases, stale epochs, and late releases
cannot authorize teardown or reopen a newer preparation. Unconsumed leases expire
at the preparation deadline. `abortMaintenance(lease)` cancels a prepared handoff.
Ordinary `close()` refuses to bypass an in-progress preparation; existing non-
maintenance shutdown remains a separate destructive lifecycle operation.

Quiescence is a **pre-teardown certificate**, not rollback of teardown. Once the
lease is consumed or an ordinary close starts, the gate cannot revive that
runtime. A replacement process cannot inherit the lease: certificates and task
ownership are deliberately not serialized. Existing directory ownership and
local-data startup validation still apply; this change adds no persisted store,
no migration, and no permission to replay ambiguous external side effects.

## Telegram and MCP durability blocker

The current client inbox deduplicates in memory; it does not persist an acceptance
receipt. Consequently **no push delivery is ACKed based on this inbox**, including
Telegram. This applies to live notifications, pending retrieval, and duplicates.
Capability negotiation does not prove a server's persistence or retention policy.

Telegram's server-side pending events are also memory-only, and runtime close/idle
cleanup deletes them. Keeping its subscription open is not a durability proof.
Whenever a configured MCP connection's capabilities are unknown, or this runtime
has negotiated push notifications, preparation refuses quiescence and aborts
without disconnecting MCP or closing a pending queue. Removing a previously seen
push binding does not manufacture a durability proof.

**Telegram-enabled maintenance remains blocked until durable inbox/ACK/replay work
is implemented and verified.** No Telegram spool or server lifecycle change is
included here. Because advancing the current pending-queue protocol requires ACK,
recovery reads one bounded page without ACK and explicitly logs incomplete recovery
if `hasMore` is true; it cannot safely advance further. Live delivery continues,
and upstream events remain unacknowledged. This preserves the maintenance safety
boundary but is not a claim that today's volatile upstream survives server crashes,
ordinary shutdown, or idle cleanup.

Buffered accepted memory recalls, unflushed memory history, pending resource
updates without durable acceptance, and reported memory write failures also fail closed. Unresolved
realtime setup, media/tool cleanup, or remote-end failure retains work ownership
and cannot certify zero active work.

## Observability

`GET /v1/introspect/admission` exposes state (`open`, `draining`, `quiescent`,
`closed`), epoch, deadline, active/deferred counts, safety blockers, and the latest
abort/release reason. These diagnostics contain no event bodies, media, prompts,
tokens, or credentials. Health remains liveness, not maintenance readiness.
