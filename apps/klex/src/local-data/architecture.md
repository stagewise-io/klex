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

`identity/private-key.pem`, `SOUL.md`, locks, logs, downloaded assets, installer receipts, and reconstructable caches are not migration stores. Private identity keys are opaque and must never be transformed by a local-data migration.

## Metadata contract

JSON documents contain a top-level `_klex` property. SQLite databases store equivalent values in the `meta` table.

- `store` is the stable registry ID and prevents opening a file as the wrong store.
- `schemaVersion` identifies the representation generation and advances through contiguous up migrations.
- `compatibilityVersion` is the minimum reader/writer capability. Raise it when an older binary could parse the representation but cannot preserve or interpret it safely.
- `minimumKlexVersion` is the actionable version shown to users. It is diagnostic; semver ordering is not the compatibility gate.
- `writtenByKlexVersion` identifies the last writer.

A binary rejects higher schema or compatibility versions without mutation. Lower schema versions require a complete one-version-at-a-time migration chain. Existing files with missing, malformed, or mismatched metadata are corruption errors, not fresh stores.

## Startup order

For every direct, headless, selected, or newly created agent:

1. Ensure the data directory exists.
2. Acquire its exclusive directory lock.
3. Load the central registry.
4. Run local-data recovery and full-registry read-only preflight.
5. If required, checkpoint and migrate.
6. Only then start tracing, config, Cloud connectivity, model logging, MCP, the API, and UI.

Agent discovery may inspect metadata without mutation. Incompatible or corrupt agents remain visible but disabled with a reason.

## Classifying a persisted change

Every change to structured persistent state must be classified before implementation:

1. **No representation change**: no store definition update.
2. **Compatible additive change**: retain versions only if old readers preserve and safely ignore the addition. JSON schemas must preserve unknown fields at evolvable boundaries.
3. **Schema migration**: increment `schemaVersion`, retain every historical version schema, and add a contiguous forward migration.
4. **Compatibility-floor change**: increment `compatibilityVersion` and set the corresponding `minimumKlexVersion` when old code must not write the new semantics even though no transformation is needed.

Migrations are deterministic, forward-only, and validated after every step. Do not add down migrations. Do not remove old SQLite columns or JSON fields until compatibility policy explicitly permits it. Add optional fields before requiring them.

The owning module exports its definition. The central registry remains the complete auditable inventory. Every change requires fixtures for old/current/newer data plus migration, downgrade-gate, failure, recovery, and unknown-field tests as applicable.

## Recovery state machine

Before the first mutation, Klex creates an owner-only checkpoint in `.klex-migrations/checkpoints/`, atomically publishes its manifest, and writes `.klex-migrations/journal.json`. The manifest records store paths, prior absence, permissions, sizes, and SHA-256 hashes.

SQLite stores are checkpointed after truncating WAL while the directory lock is held and before service clients exist. Restore removes database sidecars before replacing the database. Files absent before migration are removed on restore.

Each migration is applied in registry order and its result is validated. Success marks the checkpoint successful and removes the journal. Failure restores every targeted store as one unit, verifies hashes, marks the checkpoint failed, removes the journal, and aborts startup. An active journal on the next startup triggers deterministic restoration before preflight retries.

Klex retains the newest three successful checkpoints and newest failed checkpoint. Recovery artifacts are disaster-recovery evidence, not a supported downgrade or history-merging mechanism. Restoring an older checkpoint can discard all work created afterward.

## Downgrades and errors

A downgrade is safe only while all persisted schema and compatibility versions remain within the older binary's declared support. Otherwise startup fails before mutation. Diagnostics identify the store and path, persisted and supported versions, last writer, and minimum Klex version required.

Cloud API and agent-contract compatibility are separate from local format compatibility. Local enrollment metadata is versioned, but the migration coordinator does not negotiate remote protocol versions.
