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
| `skill-registry` | `skills/registry.json` | JSON | Optional |

Initialization creates missing parent directories for nested stores. SQLite definitions may declare `initPragmas`, which run one by one before `initSql` only when the database is created. Settings such as `auto_vacuum` take effect only on an empty file and are never re-applied to existing stores.

`identity/private-key.pem`, `SOUL.md`, episode JSONL files under `episodic/`, skill `SKILL.md` folders under `skills/{namespace}/` (and legacy learned folders under `extensions/io.stagewise/learning/skills/` awaiting import), locks, logs, downloaded assets, and reconstructable caches are not migration stores. Private identity keys are opaque and must never be transformed by a migration. Soul, episode, and skill files are plain documents, not versioned migration stores; skill files use Agent Skills frontmatter for metadata and a Markdown instruction body, and readers skip skills they cannot parse; episode lines carry their own format version `v` and readers skip lines they cannot validate.

The learning state store uses schema v2. Its deterministic v1-to-v2 migration keeps cursor, failures, per-skill usage and sources, timestamps, legacy counters and unknown fields. Activity counters and skill activity positions start at zero; pending weighted changes, retry scheduling and deferred references start empty. Historical wall-clock timestamps never become synthetic episode activity. Older writers reject v2 before mutation; skill and episode documents remain unchanged.

Learning state compatibility v2 adds the default-false `userEdited` flag in Klex 0.24.0. The representation remains schema v2; the compatibility floor prevents older writers from ignoring protection of user edits during consolidation. The historical v1 schema remains unchanged.

Learning state compatibility v3 (Klex 0.28.0) marks the move of learned skills into the core skill registry. On start, the learning extension imports each parsable legacy folder from `extensions/io.stagewise/learning/skills/` into `skills/learning/`, seeding usage from `skills` in the learning state, then deletes the folder; unparsable folders stay and are retried. `skills` keeps only entries for folders still in place; once the legacy root is gone, it is emptied. The representation remains schema v2 and `skills` stays a valid field until a later schema removes it. The floor stops older binaries, which would see no learned skills and relearn them into the legacy location, from starting on imported data.

The skill registry store (`skills/registry.json`, schema v1, Klex 0.28.0) holds bookkeeping only: the agent activity `turn` and, per qualified id `namespace/name`, ISO dates, turn positions, read count, `userEdited` and namespace-owned `metadata`. It has no migrations. Unknown top-level and per-skill fields are preserved. The `SKILL.md` documents are the source of truth; entries without a document are dropped on the next write, and a document without an entry gets fresh usage, written only once the skill is read, edited or written.

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

Released schemas, nested schemas, defaults, and migration outputs are immutable contracts. Verify them against release history before editing. Deleted or withdrawn releases still count as released. If release status is uncertain, treat the contract as released. Do not tighten a historical validator to match the current runtime model or fold a new transformation into an old migration. Removing an optional field, including an empty list, requires a new schema version and a new step. Historical fixtures must retain their original shape and metadata. Test them through registered startup preflight and migration, not only the runtime parser. The repository's `local-data-migrations` skill contains the release audit and regression checklist.

Session-history schema 2→3 adds nullable `sessions.generation_error` in Klex 0.26.0.
Existing rows start without an unresolved warning. Failed turns create a row even
without transcript messages; successful replacement turns resolve older warnings
for the same logical session. The registered store uses the existing checkpoint,
preflight, and recovery path, and older binaries reject schema 3 before writing.

## Instinct API and model-call availability migrations

Config schema 5→6 raises compatibility to 8 and adds instinct configuration and an empty instinct selection to the released schema 5 shape. Empty instinct selections use the ordered Chat models through generation without changing saved configuration. Explicit instinct entries choose generation/evaluation and an optional bounded attempt timeout; omission uses the remaining shared budget. This released migration also introduces the TypeSafe AI and Vercel AI Gateway provider types. Released schemas 1–6 retain all three voice lists. Provider model kinds and voice capability metadata still classify TTS/STT models. Other model purposes retain their original contract; the public `configVersion: 2` is unchanged. Config schema 6 shipped in `0.22.0` and remains in `0.26.0`; its historical minimum-version diagnostic is `0.18.0`, not its first release.

Model-call SQLite schema 2→3 raises compatibility to 2 and adds nullable `api`, `token_usage_reported`, and `cache_usage_reported` columns. Historical rows keep unknown (`null`) API/availability rather than claiming measured usage. New availability flags distinguish fully reported totals/cache metrics from absent or incomplete pairs; individually reported numbers are retained. Existing numeric columns remain additive storage, and aggregate usage reports incompleteness counts so sums with missing metrics are recognized as reported lower bounds, not complete consumption or cost estimates. No synthetic operation-test source or verification store is introduced.

Both migrations use the same registered checkpoint/preflight/recovery path below and reject incompatible older writers before mutation.

Gateway Jev uses `typesafe-ai/jev` with the instinct evaluation API, independently of the direct TypeSafe `jev-latest` model. Compatibility 8 blocks older config writers that cannot preserve the new provider types and instinct semantics. Released config schemas 1–6 remain frozen. Config remains registered in `local-data-registry`; checkpoint, failure, and recovery behavior is unchanged.

## STS-only voice selection migration

Config schema 6→7 first ships in `0.27.1` and removes only `modelSelection.voice.tts` and `modelSelection.voice.stt`. STS entries, `voiceId`, provider options, `audioListening`, providers, instinct settings, and other config values are preserved. Compatibility remains 8 because the schema bump already prevents older writers from opening the transformed config. The minimum-version diagnostic becomes `0.27.1`.

Version `0.27.0` incorrectly changed the already released schema 6 and the 5→6 migration in place. Existing schema-6 configs failed preflight on their legacy voice keys. The fix restores that historical contract and adds the separate 6→7 step. Schema-6 files written by `0.27.0` without TTS/STT keys also pass validation and migrate. The migration uses the registered checkpoint, preflight, and recovery path.

## Immutable migration history and CI

`local-data-migrations/` groups frozen snapshots by store and transition:

```text
local-data-migrations/
  config/
    v1-to-v2/
      migration.ts   # configV1ToV2
      v1.ts          # raw configV1Schema, nested schemas and inferred types
      v2.ts          # raw configV2Schema and transformation output schema
      schemas.ts     # versioned storage validators
      validation.ts  # local historical validation helper
    v2-to-v3/
      ...            # independent snapshots; no imports from v1-to-v2
  learning-extension-state/v1-to-v2/
  model-calls/v1-to-v2/
  model-calls/v2-to-v3/
  sessions/v1-to-v2/
  sessions/v2-to-v3/
  local-data-migrations.ts  # append-only registration
```

Each transition owns its transformation, raw input/output schemas, nested schemas,
constants, helpers and inferred types. No shared contracts file, current/legacy
schema distinction or import from another transition is allowed. Version numbers
refer to persisted `schemaVersion`, not the public `configVersion: 2`. Duplicate
snapshots are intentional: changing the live `config/schema.ts` must never change
a previously registered migration. Raw validators stay Zod schemas, not parsing
functions wrapped in another schema. The local preserving wrapper retains the
released config storage behavior (validation without normalization).

Fresh SQLite initialization and current Drizzle table definitions stay in their
owning modules. SQLite transitions contain only their historical SQL and constants;
they do not import the current database schema.

The only mutable history file is the literal `LOCAL_DATA_MIGRATIONS` registry. Append
new imports and append new entries to a store's arrays. Never remove, replace, or
reorder their existing prefix. Register every store with migrations there, then
use its arrays directly in the owning store definition. Runtime-registry tests
verify that wiring and the latest schema version.

`Local Data Migrations` CI compares against the PR target commit (or the pre-push
commit on `main`), not a checksum manifest supplied by the PR. Once merged, **all**
history files and frozen fixtures are immutable, including migrations shipped
only in nightlies. Edits, deletion and renames fail. A new migration must be
contiguous and have a new historical output schema for JSON. Historical code can
import only files inside the same transition folder, Zod, and type-only `JsonMigration` or
`SqliteMigration` interfaces. Runtime application imports, re-exports, side-effect
imports, `require` and dynamic imports fail the dependency check. Keep imports
explicit and the registry data-only; the dependency-free checker intentionally
accepts a narrow TypeScript syntax instead of executing registry code.

The first extraction has no prior history directory to compare and is a
reviewed bootstrap. It preserves the `v0.27.1` behavior and versions: config 7/8,
model calls 3/2, sessions 3/1 and learning state 2/2 (schema/compatibility).
Subsequent PRs compare to this merged baseline. Corrections always add a new
forward migration; there is no runtime checksum metadata or engine redesign.

`local-data-migration-fixtures/` contains literal, representative persisted data,
not production secrets or snapshots generated from current parsers. Config covers
versions 1–7, populated/empty/absent legacy voice selections, the broken `0.27.0`
shape, provider options and environment placeholders. SQL fixtures independently
freeze the older model-call and session layouts; learning JSON fixtures retain
unknown fields. Upgrade tests seed these files, run registered startup, read them
through their owners, check expected values/metadata, restart and compare file
bytes and mtimes. Existing downgrade, corruption, failure and recovery tests remain.
Fixtures sample important shapes; they are not a proof for every possible input
or against behavioral changes in external dependencies.

Run locally (use the actual target commit/ref):

```sh
node --test scripts/check-local-data-migrations.test.mjs
node scripts/check-local-data-migrations.mjs origin/main
pnpm -F @stagewise/klex test src/local-data src/local-data-registry src/config
```

Repository administrators must require the **Local Data Migrations** check in branch
protection/rulesets. Committing the workflow alone does not enforce merge blocking;
changes to the guard or workflow also need normal trusted review.

## Recovery state machine

Before the first mutation, Klex creates an owner-only checkpoint, atomically publishes its manifest, and writes a journal. SQLite stores are checkpointed after truncating WAL while the directory lock is held. Each migration is applied in registry order and validated. Success removes the journal; failure restores every targeted store as one unit, verifies hashes, marks the checkpoint failed, and aborts startup. An active journal on the next startup triggers restoration before preflight retries.

Klex retains the newest successful checkpoints and the newest failed checkpoint. Recovery artifacts are disaster-recovery evidence, not a supported downgrade mechanism.

## Downgrades and errors

A downgrade is safe only while all persisted schema and compatibility versions remain within the older binary's declared support. Otherwise startup fails before mutation. Diagnostics identify the store, path, persisted and supported versions, last writer, and minimum Klex version required.

Cloud API and agent-contract compatibility are separate from local format compatibility.
