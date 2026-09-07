---
name: local-data-migrations
description: Rules for changing Klex config schemas, SQLite schemas, persisted JSON, store metadata, local-data definitions, or migration and recovery code.
---

# Local data migrations

Read `apps/klex/src/local-data/architecture.md` before changing persistent state.

## Required workflow

1. Classify the change as one of:
   - No representation change.
   - Compatible additive change.
   - Schema migration.
   - Compatibility-floor increase.
2. Update the store definition in its owning module.
3. Confirm the definition remains present in `local-data-registry`.
4. Add old/current/newer fixtures and downgrade, failure, and recovery tests appropriate to the classification.
5. Run local-data tests, the owning module tests, typecheck, lint, executable build, and native smoke verification.

## Compatibility rules

- Migrations are forward-only. Never add a down migration.
- Increment `schemaVersion` for transformations and add contiguous single-version steps with input and output schemas.
- Increment `compatibilityVersion` when an older writer could discard or misinterpret new semantics without requiring a representation transformation.
- Set `minimumKlexVersion` to the first binary supporting the new schema or compatibility floor.
- Preserve unknown JSON fields at every evolvable object boundary. If that is unsafe, raise compatibility instead of silently stripping data.
- Prefer optional additions. Delay destructive SQLite column/table removal and JSON field removal across multiple release cycles.
- Keep preflight read-only across the entire registry before the first mutation.
- Treat checkpoints as disaster recovery, never as routine downgrade or divergent-history merging.
- Never migrate, regenerate, checkpoint as structured data, or replace `identity/private-key.pem`.
- Do not fold Cloud API compatibility into local storage versions.
