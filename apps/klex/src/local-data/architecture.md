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
| `episodic-search-index` | `extensions/io.stagewise/memory/episodic-search.sqlite` | SQLite | Created when missing |
| `learning-extension-state` | `extensions/io.stagewise/learning/state.json` | JSON | Optional |
| `episode-summaries` | `extensions/io.stagewise/episode-summary/summaries.sqlite` | SQLite | Created when missing |
| `sessions` | `sessions.sqlite` | SQLite | Created when missing |

Initialization creates missing parent directories for nested stores. SQLite definitions may declare `initPragmas`, which run one by one before `initSql` only when the database is created. Settings such as `auto_vacuum` take effect only on an empty file and are never re-applied to existing stores.

`identity/private-key.pem`, `SOUL.md`, episode JSONL files under `episodic/`, learned `SKILL.md` folders under `extensions/io.stagewise/learning/skills/`, locks, logs, downloaded assets, and reconstructable caches are not migration stores. Private identity keys are opaque and must never be transformed by a migration. Soul, episode, and skill files are plain documents, not versioned migration stores; skill files use Agent Skills frontmatter for metadata and a Markdown instruction body, and readers skip skills they cannot parse; episode lines carry their own format version `v` and readers skip lines they cannot validate.

The learning state store uses schema v2. Its deterministic v1-to-v2 migration keeps cursor, failures, per-skill usage and sources, timestamps, legacy counters and unknown fields. Activity counters and skill activity positions start at zero; pending weighted changes, retry scheduling and deferred references start empty. Historical wall-clock timestamps never become synthetic episode activity. Older writers reject v2 before mutation; skill and episode documents remain unchanged.

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

## Instinct API and model-call availability migrations

Config schema 7→8 raises compatibility to 10 and materializes `api: 'generation'` on historical instinct selections. Order and provider options are preserved, and no attempt timeout is added: omission retains the existing remaining-budget behavior. The current instinct entries can explicitly choose generation/evaluation and an optional bounded attempt timeout. Other model purposes retain their original contract; the public `configVersion: 2` is unchanged.

Model-call SQLite schema 2→3 raises compatibility to 2 and adds nullable `api`, `token_usage_reported`, and `cache_usage_reported` columns. Historical rows keep unknown (`null`) API/availability rather than claiming measured usage. New availability flags distinguish fully reported totals/cache metrics from absent or incomplete pairs; individually reported numbers are retained. Existing numeric columns remain additive storage, and aggregate usage reports incompleteness counts so sums with missing metrics are recognized as reported lower bounds, not complete consumption or cost estimates. Synthetic operation tests use explicit `operation-test` source attribution and no chat session identity. No verification store is introduced.

Both migrations use the same registered checkpoint/preflight/recovery path below and reject incompatible older writers before mutation.

## Gateway config compatibility

Config schema 8→9 preserves the existing representation and selections while adding the native `vercel-ai-gateway` provider. Compatibility 11 blocks older writers that cannot interpret this provider. Historical schema 8 remains frozen. Gateway Jev uses `typesafe-ai/jev` with the instinct evaluation API, independently of the direct TypeSafe `jev-latest` model. Config remains registered in `local-data-registry`; checkpoint, failure, and recovery behavior is unchanged.

## Recovery state machine

Before the first mutation, Klex creates an owner-only checkpoint, atomically publishes its manifest, and writes a journal. SQLite stores are checkpointed after truncating WAL while the directory lock is held. Each migration is applied in registry order and validated. Success removes the journal; failure restores every targeted store as one unit, verifies hashes, marks the checkpoint failed, and aborts startup. An active journal on the next startup triggers restoration before preflight retries.

Klex retains the newest successful checkpoints and the newest failed checkpoint. Recovery artifacts are disaster-recovery evidence, not a supported downgrade mechanism.

## Downgrades and errors

A downgrade is safe only while all persisted schema and compatibility versions remain within the older binary's declared support. Otherwise startup fails before mutation. Diagnostics identify the store, path, persisted and supported versions, last writer, and minimum Klex version required.

Cloud API and agent-contract compatibility are separate from local format compatibility.
