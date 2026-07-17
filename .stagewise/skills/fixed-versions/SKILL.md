---
name: fixed-versions
description: Enforces pinned exact versions for all dependency installs and updates. Use when installing, updating, or reviewing package dependencies.
---

# Fixed Versions

**Always use exact (pinned) versions.** No ranges (`^`, `~`, `*`). No floating.

## Rules

1. **Install with exact version.** `pnpm add pkg@5.0.0` → locks `5.0.0` in `package.json`. Never `pnpm add pkg` (resolves to `^latest`).

2. **Update by specifying the target version.** `pnpm add pkg@4.2.1` overwrites the existing entry. Never `pnpm update pkg` (shifts within range).

3. **Verify after install.** Check `package.json` — version must have **no** `^` or `~` prefix.

4. **`workspace:*` is exempt.** Inter-workspace links always use `workspace:*`.

5. **DevDependencies too.** Same rule — exact versions, no ranges.

## Rationale

- Reproducible installs across machines and CI.
- No silent breaking changes from minor/patch bumps.
- Explicit upgrade intent — version changes are visible in diffs.
