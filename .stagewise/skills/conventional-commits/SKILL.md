---
name: conventional-commits
description: Enforces conventional commit format with compact bullet bodies. Use when committing or amending any commit.
---

# Conventional Commits

Use for every commit in this repo. No exceptions.

## Format

```
<type>: <compact summary>

- <bullet> (only if summary alone insufficient)
- <bullet>
```

## Rules

1. **Conventional commit type prefix.** `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `build:`, `ci:`, `test:`, `perf:`, `style:`, `revert:`. Lowercase, no space before colon.

2. **Summary line ≤ 72 chars.** Imperative mood. No period. Describes the change — not the file.

3. **Body is optional.** Add bullets **only** when the summary alone doesn't convey the full change. If summary is enough → stop there. No body.

4. **Bullets are compact.** One change per bullet. No prose, no explanation, no rationale. `Added X`, `Removed Y`, `Changed Z to W`.

5. **No `Co-authored-by`, no trailers** unless explicitly requested.

6. **Scope optional.** `feat(admin): add health endpoint` — scope in parens after type. Use when change targets a specific subsystem.

## Examples

Summary only — sufficient:
```
chore: remove LICENSE file
```

Summary + bullets — summary alone insufficient:
```
feat(fluid-agent): add tslog logger and admin server

- Add logger factory with tslog v5
- Add AdminAPI module with Hono server on port 2706
- Add /v1/health endpoint
- Add graceful shutdown via SIGINT/SIGTERM
```

Too verbose — don't do this:
```
feat(fluid-agent): add tslog logger and admin server

This commit introduces a new logging system based on tslog v5
which provides structured logging with child loggers for each
module. We also add an AdminAPI class that encapsulates a Hono
server listening on port 2706 with a health check endpoint...
```
