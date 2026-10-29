---
name: local-data-migrations
description: Rules for changing Klex config schemas, SQLite schemas, persisted JSON, store metadata, local-data definitions, or migration and recovery code.
---

# Local data migrations

Read `apps/klex/src/local-data/architecture.md` before changing persistent state.

## Required workflow

1. Establish the released baseline before editing. Inspect release tags and the store definition, schemas, nested schemas, defaults, and migration helpers at the relevant released commits. Compare against the latest release and the release that introduced the affected version. Do not infer release status from comments, the branch name, the current package version, or an agent's earlier claim. A withdrawn or deleted release still counts. If history is unavailable or ambiguous, treat the contract as released and report the uncertainty.
2. Classify the change as one of:
   - No representation change.
   - Compatible additive change.
   - Schema migration.
   - Compatibility-floor increase.
3. Update the store definition in its owning module as required by the classification. For a schema migration, add a new schema and one new forward step from the current version. Compatible additive changes may retain versions only when older readers preserve and safely ignore the addition. Keep the old schema and old steps intact. Review shared dependencies for accidental changes to historical behavior.
4. Confirm the definition remains present in `local-data-registry`.
5. Add old/current/newer fixtures and downgrade, failure, and recovery tests appropriate to the classification. Follow the regression checklist below.
6. Run local-data tests, the owning module tests, typecheck, lint, executable build, and native smoke verification. Report failures and skipped checks explicitly. Do not describe a parser-only test as startup verification.
7. Include the released baseline, change classification, old and new schema/compatibility versions, minimum supported binary version, and validation results in the PR or handoff. Explain any manual recovery needed before the updater can start.

## Released contracts are immutable

A stored version is a permanent contract with data already on users' machines. Never fix a new feature by rewriting that contract.

- Never edit a released migration's behavior or reuse its version number for a different transformation. Append a new contiguous step.
- Never narrow a historical validator to the current runtime shape. Keep explicit historical schemas, including their nested schemas and defaults. A shared helper or schema edit can change old versions even when the version registry is untouched.
- Removing an optional property, rejecting an empty legacy list, changing a persisted enum or discriminator, or moving a field is a representation change. Runtime code no longer using a field does not make existing stored data invalid.
- Keep historical fixtures as evidence. Do not remove legacy fields, change their metadata to the new version, or regenerate their expected shape from the current parser just to make tests pass. Add a separate current fixture.
- If a broken binary has already shipped, account for both the pre-existing released shape and any shape the broken binary could have written. Preserve valid data in each case. Do not silently accept arbitrary corruption.

## Required regression checks

Use literal or frozen fixtures whose expected historical shape is independent of the current parser. Include realistic selections and options, not just an empty default config.

- Validate the old fixture with its historical schema and assert that any existing migration still produces its released output.
- Run old files with their real `_klex` metadata through the registered `createLocalData(...).start()` path, then load them through the owning module. The runtime parser alone cannot catch preflight rejection.
- For removed optional collections, cover populated, empty, and absent values. If a broken release wrote a different shape, add that fixture too.
- Assert preservation of unrelated values, nested options, environment placeholders, and unknown JSON fields where supported. Assert only the intended transformation and metadata changes.
- Run startup twice and assert the second run does not rewrite or remigrate the file.
- Assert an older reader rejects the new schema or compatibility floor before mutation. Assert invalid old data and data from a newer schema remain byte-for-byte unchanged.
- Inject migration failure and assert restoration of the original bytes, then prove a clean retry succeeds. Cover interrupted-startup recovery when recovery behavior changes.

## Failure example from `0.27.0`

Schema 6 had already shipped with `modelSelection.voice.tts` and `stt`. Removing those fields from schema 6 and folding their removal into 5→6 caused existing schema-6 files to fail read-only preflight. The 5→6 migration never ran for those files. Even empty lists caused startup failure. The updater starts later, so publishing a fixed release alone could not recover crash-looping bots.

The repair restores schema 6 and 5→6, adds schema 7 with a separate 6→7 removal step, and tests both legacy schema-6 files and STS-only files written by `0.27.0`. Apply the same reasoning to every persisted store, not only config.

## Compatibility rules

- Migrations are forward-only. Never add a down migration.
- Increment `schemaVersion` for transformations and add contiguous single-version steps with input and output schemas.
- Increment `compatibilityVersion` when an older writer could discard or misinterpret new semantics without requiring a representation transformation.
- Set `minimumKlexVersion` to the first binary supporting the new schema or compatibility floor.
- Preserve unknown JSON fields at every evolvable object boundary. If that is unsafe, raise compatibility instead of silently stripping data.
- Prefer optional additions. Delay destructive SQLite column/table removal and JSON field removal across multiple release cycles.
- Keep preflight read-only across the entire registry before the first mutation.
- Treat checkpoints as disaster recovery, never as routine downgrade or divergent-history merging.
- Never migrate, regenerate, replace, or include `identity/private-key.pem` as structured data in a checkpoint.
- Do not fold Cloud API compatibility into local storage versions.
