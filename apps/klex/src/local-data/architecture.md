# Local data migrations

Klex treats an agent data directory as a versioned asset. Persisted formats evolve forward only. A binary must prove that every registered store is compatible before any service reads or writes local state.

## Store inventory

The composition root in `local-data-registry` contains every structured Klex-owned store:

| Store ID | Path | Format | Presence |
| --- | --- | --- | --- |
| `config` | `config.json` | JSON | Required |
| `model-calls` | `model-calls.sqlite` | SQLite | Created when missing |
| `mcp-oauth` | `credentials/mcp-oauth.json` | JSON | Optional |
| `cloud-identity-metadata` | `identity/metadata.json` | JSON | Optional |
| `cloud-enrollment` | `identity/enrollment.json` | JSON | Optional |
| `todos-extension-todos` | `extensions/io.stagewise/todos/todos.json` | JSON | Optional |

`identity/private-key.pem`, `SOUL.md`, episode Markdown under `episodic/`, locks, logs, downloaded assets, and reconstructable caches are not migration stores. Private identity keys are opaque and must never be transformed by a migration. Soul and episode files are user-readable documents, not versioned migration stores.

## Metadata contract

JSON documents contain a top-level `_klex` property. SQLite databases store equivalent values in the `meta` table.

- `store` — stable registry ID; prevents opening a file as the wrong store.
- `schemaVersion` — identifies the representation generation; advances through contiguous up migrations.
- `compatibilityVersion` — minimum reader/writer capability; raise when an older binary could parse but cannot safely preserve or interpret the representation.
- `minimumKlexVersion` — actionable version shown to users; diagnostic, not the compatibility gate.
- `writtenByKlexVersion` — last writer.

A binary rejects higher schema or compatibility versions without mutation. Lower schema versions require a complete one-version-at-a-time migration chain. Existing files with missing, malformed, or mismatched metadata are corruption errors, not fresh stores.

## Startup order

For every agent:

1. Ensure the data directory exists.
2. Acquire its exclusive directory lock.
3. Load the central registry.
4. Run local-data recovery and full-registry read-only preflight.
5. If required, checkpoint and migrate.
6. Only then start tracing, config, Cloud connectivity, model logging, MCP, the API, and UI.

Agent discovery may inspect metadata without mutation. Incompatible or corrupt agents remain visible but disabled with a reason.

## Classifying a persisted change

1. **No representation change**: no store definition update.
2. **Compatible additive change**: retain versions only if old readers preserve and safely ignore the addition.
3. **Schema migration**: increment `schemaVersion`, retain every historical version schema, add a contiguous forward migration.
4. **Compatibility-floor change**: increment `compatibilityVersion` and set `minimumKlexVersion` when old code must not write the new semantics even though no transformation is needed.

Migrations are deterministic, forward-only, and validated after every step. Do not add down migrations. Do not remove old SQLite columns or JSON fields until compatibility policy permits. Add optional fields before requiring them.

## Recovery state machine

Before the first mutation, Klex creates an owner-only checkpoint, atomically publishes its manifest, and writes a journal. SQLite stores are checkpointed after truncating WAL while the directory lock is held. Each migration is applied in registry order and validated. Success removes the journal; failure restores every targeted store as one unit, verifies hashes, marks the checkpoint failed, and aborts startup. An active journal on the next startup triggers restoration before preflight retries.

Klex retains the newest successful checkpoints and the newest failed checkpoint. Recovery artifacts are disaster-recovery evidence, not a supported downgrade mechanism.

## Downgrades and errors

A downgrade is safe only while all persisted schema and compatibility versions remain within the older binary's declared support. Otherwise startup fails before mutation. Diagnostics identify the store, path, persisted and supported versions, last writer, and minimum Klex version required.

Cloud API and agent-contract compatibility are separate from local format compatibility.
