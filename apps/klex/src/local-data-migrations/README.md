# Frozen local-data migrations

See [the architecture](../local-data/architecture.md#immutable-migration-history-and-ci) for the storage lifecycle and CI rules.

- One store directory, one `vN-to-vN+1` folder per forward step.
- `migration.ts` exports a version-named transformation (`configV6ToV7`, etc.).
- JSON transitions own raw input/output Zod schemas, nested schemas, inferred types and helpers. Config uses `vN.ts` and `schemas.ts` for storage registration.
- No shared contracts. A transition cannot import another transition or live application code. Zod and type-only migration interfaces are the only external exceptions.
- Deliberate copies are immutable snapshots, not candidates for deduplication.
- Append imports and array entries in `local-data-migrations.ts`. Never edit, remove, rename or reorder merged history. Corrections require a new version and step.
- Application types and the current config schema live in `config/schema.ts`, outside this directory.

Baseline: `v0.27.1`. This extraction changes no persisted versions or migration behavior. Config remains schema 7, compatibility 8; model calls 3/2; sessions 3/1; learning state 2/2.
