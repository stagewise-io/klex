# Local data migrations

Klex treats an agent data directory as a versioned asset. Persisted formats evolve forward only. A binary must prove that every registered store is compatible before any service reads or writes local state.

## Store inventory

The composition root in `local-data-registry` contains every structured Klex-owned store:

| Store ID | Path | Format | Presence |
| --- | --- | --- | --- |
| `config` | `config.json` | JSON | Required |
| `model-calls` | `model-calls.sqlite` | SQLite | Created when missing |
| `mcp-oauth` | `credentials/mcp-oauth.json` | JSON | Optional |
| `provider-credentials` | `credentials/providers.json` | JSON | Optional |
| `cloud-identity-metadata` | `identity/metadata.json` | JSON | Optional |
| `cloud-enrollment` | `identity/enrollment.json` | JSON | Optional |
| `todos-extension-todos` | `extensions/io.stagewise/todos/todos.json` | JSON | Optional |
| `episodic-search-index` | `extensions/io.stagewise/memory/episodic-search.sqlite` | SQLite | Created when missing |
| `learning-extension-state` | `extensions/io.stagewise/learning/state.json` | JSON | Optional |
| `episode-summaries` | `extensions/io.stagewise/episode-summary/summaries.sqlite` | SQLite | Created when missing |
| `sessions` | `sessions.sqlite` | SQLite | Created when missing |
| `skill-registry` | `skills/registry.json` | JSON | Optional |
| `memory-writer-state` | `extensions/io.stagewise/memory/writer-state.json` | JSON | Optional |

Initialization creates missing parent directories for nested stores. SQLite definitions may declare `initPragmas`, which run one by one before `initSql` only when the database is created. Settings such as `auto_vacuum` take effect only on an empty file and are never re-applied to existing stores.

`identity/private-key.pem`, `SOUL.md`, inactive legacy episode JSONL files under `episodic/`, skill `SKILL.md` folders under `skills/{namespace}/` (and legacy learned folders under `extensions/io.stagewise/learning/skills/` awaiting import), locks, logs, downloaded assets, and reconstructable caches are not migration stores. Private identity keys are opaque and must never be transformed by a migration. Soul and skill files are plain documents, not versioned migration stores; skill files use Agent Skills frontmatter and readers skip skills they cannot parse. Legacy episode files are untouched inactive artifacts: runtime never opens, scans or writes them.

The memory writer replaces the wired learning worker, retaining legacy learned-skill import. Writer state and entity documents belong to `extensions/io.stagewise/memory`. Its registered JSON state preserves the canonical-message cursor, pending boundary and unknown fields; processing is sequential and retries are at-least-once. Entity Markdown documents are plain documents, like skill files, not JSON/SQLite migration stores.

Memory documents use `entities/{entityType}/{name}.md` and `FormatVersion: 6`. The lowercase kebab-case folder supplies the type; the filename supplies the display name and type-qualified identity (for example, `person/Ada Lovelace`). Frontmatter has no `Title`, `Id`, `EntityType` or `MergedFrom`. Names preserve spelling and casing, normalize to NFC, replace unsafe filename/link characters, and are unique within each type ignoring case. New creation and renaming reject duplicate names. Slash-separated namespaces are retained as nested folders (for example `project/stagewise-io/klex`); the full name after the type is the display name. Readers recurse through all levels, excluding hidden editor-metadata directories such as `.obsidian`; these are left untouched. Each segment is normalized independently; empty, absolute, traversal and `.md`-suffixed segments are rejected. Names are bounded to 200 characters/400 UTF-8 bytes, with each segment bounded to 100 characters/200 bytes. Shared parent folders reuse their existing casing; conflicting hand-created casing and symlinks stop loading. Writes and journal replay validate every ancestor without following symlinks. Rename/merge removes only empty former folders. Previously converted space-separated names cannot be automatically restored to slash names; restore untouched test data or rename them explicitly.

On first startup, the writer validates all documents before converting legacy formats 1–3 directly from their frontmatter titles to format-4 filenames, including UUID-based files. Current filenames reserve their names first; legacy files are processed in sorted original-path order. Conversion resolves collisions within each type with ` 2`, ` 3`, and subsequent available suffixes. Relations and whole-reference mentions in current facts, citation labels and superseded facts are rewritten together; timestamps, evidence citation IDs and unrelated content are preserved. Legacy `MergedFrom` entries resolve interrupted merges and references during conversion, then disappear. No intermediate profanity cleanup or random-ID regeneration runs; the generator and dictionary are deleted.

Conversion, rename, retype and merge publish final document snapshots in a temporary `entities/.moves.json` journal before changing files. Startup replays an interrupted operation; successful completion deletes the journal. No permanent merge aliases remain, and a completed conversion does not rewrite files on subsequent startups. Unsupported formats, malformed documents, unsafe type folders, duplicate existing identities and conflicting linked identities stop the writer rather than overwrite memory. Legacy installations using `extensions/io.stagewise/memory-writer` must stop the bot and move their state and entities into the current directory without overwriting destinations. Invalid legacy types require manual correction before conversion.

The released baseline `v0.37.1-nightly20261120c001` uses document format 3 and writer-state schema/compatibility 1/1 (minimum Klex 0.33.0). This change advances plain documents to format 4 and raises registered writer-state compatibility to 2, minimum Klex 0.37.1; JSON schema remains 1 and its payload is unchanged. The store remains registered, so local-data startup raises its metadata floor before the writer converts notes and older binaries reject converted installations. Existing registered migrations and historical fixtures remain unchanged. Chat history, its search index, learned-skill text and reference files are not rewritten and may still contain old IDs. Entity evidence continues to use `history:<SQLite-message-id>`; skill provenance uses SQLite message IDs. Entity relations may target any existing skill namespace. Automatic factual loading snapshots General/current facts and additional section headings; explicit section reads refresh only their requested bodies.

Relation migration (strength removal and curated predicates in one PR): the latest released baseline `v0.38.0` and the introducing release `v0.37.1-nightly20261124c002` use document format 5, with link labels `[[target|relationship (strength)]]`. One shared plain-document conversion advances format 5 to format 6, replacing the `RelatedTo` alias list with optional camelCase predicate lists of plain `[[target]]` links. Strength removal and relation restructuring happen together; no intermediate format is written or supported. Every historical target becomes `relatedTo`; labels and strengths are deliberately discarded rather than interpreted. Duplicate predicate/target pairs collapse, while different predicates may share a target. Runtime/tool relations no longer have strength. Released v1–v5 validators remain accepted unchanged, including v5 numeric-strength validation. Legacy object relations convert directly to format 6 through the same fallback conversion. The existing final-snapshot journal provides interrupted-write recovery. Registered writer-state compatibility advances once, from 2 to 3 (JSON schema remains 1, minimum Klex 0.38.2). All notes validate before conversion; malformed/newer notes stay untouched. Repeated startup does not rewrite converted notes. The writer-state definition remains registered, preserving its payload and unknown fields; existing local-data migration history is unchanged. No manual recovery is required on a valid installation. Historical release deletion/withdrawal status cannot be established from local Git tags alone; all prior contracts are treated as released.

The exact hardcoded vocabulary and inverse map live in the entity module; writer tools accept only those predicates and maintain inverse entity edges automatically, while skill links remain one-way. Current documents reject unknown keys and aliased links, and omit empty lists. Strength removal and curated relationships share the single format-5-to-6 conversion and compatibility-2-to-3 increase described above. Historical schemas and migration history remain unchanged.

Flat titles and tags (format 7): baseline is the release `v0.38.0` (format 5, writer compatibility 2), plus main's still-unreleased format 6 (compatibility 3), treated as fixed because a nightly could ship it. Format 7 stores every note at the entities root as `{Title}.md`. Titles are flat (no `/`) and unique across the root, ignoring case and NFC. Each note carries a required frontmatter `Tags` list (1–20 lowercase kebab tags, `/`-nested to depth 4). Writer-state compatibility rises once, from 3 to 4 (JSON schema remains 1, minimum Klex 0.38.2, payload unchanged); there is no new registered migration step. The one-time conversion runs only in `migrateMemoryDocuments()`, under the directory lock and before any service starts. The writer store opens notes without the migrate flag and refuses unconverted notes or unfinished legacy journals, which pauses only the writer. The conversion reads every note through the existing v1–v6 readers in memory, chaining format 5 → 6 → 7, and writes once; no format-6 file is written on the way. The title is the leaf filename and the only tag is the literal former folder path (`project/stagewise-io/klex` → title `klex`, tag `project/stagewise-io`); no plural mapping, a later consolidator normalizes them. Only case-insensitive clashing leaves are qualified, and every member of a clashing group is: ` (top-level folder)`, then ` (full folder path)`, then a number; existing parentheticals are kept (`Launch (2026) (event)`). Entity targets in every predicate list are rewritten through the old-id → title map and deduplicated; skill links are untouched. Targets without a note are dropped and logged as a warning (`entity → target`). Missing inverses are added and counted. Whole old typed IDs in facts, `was:` history and citation labels are rewritten once; afterwards, renames and merges repoint relations only, never prose. Hidden folders (`.obsidian`) are skipped, other subfolders holding format-7 notes are rejected, and invalid or newer notes abort the conversion before any write. All final snapshots go into one `.moves.json` journal, so an interrupted conversion replays on restart. Afterwards, empty former folders are removed non-recursively. A dry-run option plans and logs without writing; the app never enables it. Repeated startup rewrites nothing. Older binaries (compatibility 2 or 3) reject the raised metadata in preflight before any mutation.

The provider credential store (schema v1, Klex 0.28.3) holds registry-owned tokens for model providers with interactive authorization, keyed by provider instance ID. Records carry `type`, `status` (`authorized` or `revoked`), an optional `credential` (access, refresh and ID tokens, expiry, account ID, timestamps) and an optional sanitized `failure`. Every object boundary preserves unknown fields. Tokens rotate on refresh, so they never live in `config.json`. Like `mcp-oauth`, the file is written owner-only and has no migrations yet.

The learning state store uses schema v2. Its deterministic v1-to-v2 migration keeps cursor, failures, per-skill usage and sources, timestamps, legacy counters and unknown fields. Activity counters and skill activity positions start at zero; pending weighted changes, retry scheduling and deferred references start empty. Historical wall-clock timestamps never become synthetic episode activity. Older writers reject v2 before mutation; skill and episode documents remain unchanged.

Learning state compatibility v2 adds the default-false `userEdited` flag in Klex 0.24.0. The representation remains schema v2; the compatibility floor prevents older writers from ignoring protection of user edits during consolidation. The historical v1 schema remains unchanged.

Learning state compatibility v3 (Klex 0.28.0) marks the move of learned skills into the core skill registry. On start, the learning extension imports each parsable legacy folder from `extensions/io.stagewise/learning/skills/` into `skills/learning/`, seeding usage from `skills` in the learning state, then deletes the folder; unparsable folders stay and are retried. `skills` keeps only entries for folders still in place; once the legacy root is gone, it is emptied. The representation remains schema v2 and `skills` stays a valid field until a later schema removes it. The floor stops older binaries, which would see no learned skills and relearn them into the legacy location, from starting on imported data. The import and the `skills` map are tagged `LEGACY(skill-registry)`; the removal order is in `session/chat/architecture.md`.

The skill registry store (`skills/registry.json`, introduced at schema v1 in Klex 0.28.0) holds bookkeeping only: the agent activity `turn` and, per qualified id `namespace/name`, ISO dates, turn positions, read count, `userEdited` and namespace-owned `metadata`. Schema v2/compatibility v2 (minimum Klex 0.38.2) renames `metadata.loadOn` entries from `pushNotificationMetadataPattern` to `eventDataPattern` through a registered forward migration. Unknown top-level, per-skill and metadata fields are preserved. The `SKILL.md` documents are the source of truth; entries without a document are dropped on the next write, and a document without an entry gets fresh usage, written only once the skill is read, edited or written.

Canonical activity cutover (minimum Klex 0.28.1): session history advances schema 3→4/compatibility 1 with the same 512 MiB default retention. A nullable `messages.content_revision` stores content hashes on new writes and repairs, keeping canonical revisions stable across recorder syncs and restarts without scanning message bodies. Existing rows retain a stable timestamp/size fallback until changed. Learning remains schema 2, raising compatibility 3→4 for canonical source cursors and runtime-batch counters. Summary storage remains schema 1, raising compatibility 1→2 for canonical source cursor semantics; existing generated rows remain intact. Search schema 1→2/compatibility 1→2 drops only its disposable file-derived cache tables and creates canonical-source FTS/vocabulary tables through a registered forward migration. Deferred learning references optionally retain `firstSourceId` alongside the final source id, so revisits reconstruct the bounded original range from current canonical history rather than reloading only its last message. This additive field is preserved by the released schema-v2 passthrough validator; the canonical compatibility-v4 floor already excludes released file-based readers. Historical schemas remain unchanged. No historical contracts or fixtures change. Legacy consumer cursors pin at the newest retained source without replay, obsolete pending file work clears, and old skill citations remain unavailable legacy provenance. Fresh learning backfills a bounded recent window; first-enable titles do not backfill. No manual archive cleanup or import is required. Older writers reject these stores during preflight.

## Memory-loading persistence classification

Snapshot loading is a compatible additive sessions-store change. The released schema-4 reader/writer in `v0.28.1` and latest checked baseline `v0.37.1-nightly20261123c001` round-trips complete UI-message JSON through `JSON.parse`/`JSON.stringify`; unknown data parts are preserved and safely ignored during conversion. New `data-loadedMemories`, `data-loadedMemorySections`, `data-memoryLoadingStatus`, and `data-mcpInvocations` parts therefore retain sessions schema/compatibility 4/1 and minimum Klex 0.28.1. The logical snapshot parts themselves introduce no document-format change. The subsequent storage optimization below raises the sessions schema; historical migrations/fixtures remain unchanged. Versioned snapshot strings contain only model-visible projections, not full entity documents. Queued reads do not change entity or registry representations. Session restart tests cover preservation of the additive parts; existing local-data startup regressions still apply.

The separate event-matcher rename was rechecked against released `v0.38.1` (writer schema/compatibility 1/3, skill registry 1/1, sessions 4/1) and upstream format-7 compatibility 4: skill-registry schema/compatibility advances 1/1 → 2/2, and memory-writer-state stays schema 1 while compatibility advances to 5. Both require Klex 0.38.2. Entities retain upstream document format 7, flat title filenames, required nested tags, and curated inverse relationships. Titles do not implicitly trigger loading; only explicit LoadOn rules and LinkedIdentities do. The existing journaled startup conversion renames old `LoadOn` discriminators before publishing the entity catalogue; registered local-data preflight raises the writer-state floor first so older parsers cannot discard converted rules. Skill registry conversion preserves other rules and unknown metadata. Matching behavior is unchanged: both MCP Events and Push Notifications match paths relative to their data object, not transport-envelope fields; `server` remains a separate exact source constraint. Frozen migrations and fixtures are unchanged. Normal startup performs conversion; no manual data rewrite is required.

Skill loading adds `data-availableSkills` (qualified names/descriptions) and `data-activeSkills` (versioned active skill/reference subscriptions and checkpoint-window token), plus optional reference/window fields in immutable snapshot strings. Active subscriptions also preserve consumed-evidence hashes. Full idle replaces only the latest active-subscription annotation with an empty durable state, leaving model-visible snapshots unchanged; restarts therefore do not resurrect unloaded skills. Annotation preparation forks subscription state and commits it only after core accepts the captured history window. These are compatible additive message payloads: released `v0.38.0` sessions schema-4 readers preserve arbitrary message parts as JSON and ignore unknown data parts. No additional schema or compatibility change is required beyond the schema/compatibility 5/1 snapshot-storage floor below (minimum Klex 0.38.2); registry and document formats remain unchanged. Skill reference snapshots use the same content-addressed `loadedMemories` storage as skill bodies. No manual recovery or data rewrite is required.

### Snapshot storage deduplication

Against released baselines `v0.28.1`, `v0.38.0`, and `v0.38.1` (sessions schema/compatibility 4/1), sessions now advance to schema/compatibility 5/1, minimum Klex 0.38.2. A registered 4→5 migration adds immutable SHA-256-addressed `memory_snapshots` and a message-reference index maintained by insert/update/delete triggers. Existing inline history remains valid and is not rewritten during startup. New/changed messages store references for `loadedMemories` and `loadedMemorySections` strings, atomically with their snapshot bodies. All history read paths hydrate and verify those bodies before returning UI messages, including activity reads, paginated inspection and restored windows; revisions and byte budgets continue to use the complete logical JSON. References never depend on another message or the live entity catalogue. Queued reads cannot race cleanup; unreferenced snapshots are pruned after sync and retention eviction. Missing or hash-invalid bodies fail explicitly. Older binaries reject schema 5 before mutation. Migration failure restores the checkpoint and clean retries succeed; a second startup does not rewrite data. No new registered store, dependency, manual rewrite or historical fixture change is required.

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
6. Run mandatory memory-document conversion under the same directory lock, after registered compatibility upgrades and before Cloud connectivity or any memory consumer. This runs in both picker and headless startup even without a configured model or writer; failure aborts startup. The document snapshot journal provides retry recovery independently of JSON/SQLite checkpoints.
7. Only then start tracing, config, Cloud connectivity, model logging, MCP, the API, and UI.

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

## Provider display name migration

Config schema 8→9 first ships in `0.31.0` and only widens provider instances with an optional `displayName`. Every schema-8 payload is a valid schema-9 payload, so the step validates both contracts and returns the value unchanged. Compatibility remains 8 because the schema bump already blocks older readers. The minimum-version diagnostic becomes `0.31.0`.

## Optional dynamic-effort configuration

Config schema 9→10 adds optional effort policy (off/shadow/automatic, floor and ceiling), preserving absent settings and provider display names. Compatibility remains 8; schema 10 blocks older readers, with minimum version 0.31.1. Runtime absence selects shadow mode without changing persisted defaults. Released migrations remain unchanged.

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
