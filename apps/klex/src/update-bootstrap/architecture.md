# Update-first startup

`main.ts` creates the process logger and starts `update-bootstrap` before importing
`application`. The dynamic import is intentional: runtime schemas and native module
initializers must not prevent the updater from running, including in the SEA bundle.

## Lifecycle

With `--auto-update` (or `KLEX_AUTO_UPDATE`), a managed installation:

1. Discovers its installation without selecting an agent or opening agent data.
2. Awaits an update check. Network checks time out after ten seconds.
3. Installs an available update and restarts through the managed launcher before
   importing the application. An explicit data-directory selection is preserved in
   the restart environment; otherwise the new process still runs the agent picker.
4. If no update is available, or checking/installing fails, attempts normal startup.
5. Checks again every five minutes while healthy. Restarts still use the existing
   update drain, including realtime lease protection.

The bootstrap owns the automatic update manager, signal handlers, polling timer and
optional health listener. The application owns agent services, data handles and the
agent-directory lock. Its cleanup stack closes partially initialized resources;
startup rollback has per-step deadlines so one failed service cannot prevent later
resources from being released. Normal runtime shutdown waits for each dependency
in order, including stopping ingress before the session host and finishing transcript
writes before closing session history. Its overall deadline belongs to the shutdown
coordinator, including slow lock release and telemetry provider shutdown. Owned
provider cleanup results memoize the underlying operation, not a rollback timeout,
so actual failures cannot be hidden by a second, idempotent no-op.

Manual interactive updates retain their existing discovery and offer flow. Without
automatic updates, or outside a managed installation, a startup failure remains a
fatal error rather than leaving an idle process behind.

## Updater-only recovery

If importing or starting the application fails and an automatic updater exists:

- Log the original failure visibly, including outside the interactive UI.
- Close partially initialized application resources and release the directory lock.
- Keep the updater alive without retrying application startup in the same binary.
- Keep `/livez` available and `/readyz` false when health serving is enabled.
- Retry update checks with capped backoff. Install the next offered release, then
  restart into it using the same launcher, arguments and agent-directory selection.
- Handle termination and update restart without relying on any agent service.

The recovery timer is referenced so a process with no remaining services stays
alive. The healthy timer is unreferenced. Closing the bootstrap cancels polling and
in-flight update work, removes its signal handlers and closes owned resources.
Logging is disposed by the process-level shutdown path, after services stop.

## Storage and deployment boundaries

This lifecycle change does not change any persisted representation, store schema,
compatibility floor or minimum supported storage-reader version. Migrations still
run exclusively through the registered local-data startup path.

An older binary that already crashes before reaching its updater cannot acquire
this behavior by itself. Such installations need one external/manual update to a
binary containing this bootstrap. Recovery also requires a valid managed
installation and enabled automatic updates; it does not repair a broken launcher,
installer, release feed or bootstrap module.

## Regression coverage

`update-bootstrap.test.ts` exercises update-before-import ordering, installation
and restart, offline and bounded checks, installer failures, startup/import failure
recovery, later healing releases, healthy drain delegation, signal cleanup and
idempotency. `main.test.ts` exercises real bootstrap/application wiring with mocked
services, including config-load failure, cleanup, health readiness and restart
agent continuity, plus slow and failed lock-release and tracing cleanup. Composition tests
cover bounded partial runtime rollback and slow ordered normal shutdown. Packaged executable smoke tests verify the SEA and its
native dependencies separately.
