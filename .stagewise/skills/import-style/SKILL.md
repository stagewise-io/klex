---
name: import-style
description: Rules for ordering, grouping, and styling import statements in fluid-agent. Use when writing, modifying, or reviewing any import declaration.
---

# Import Style

Apply to every TypeScript file in fluid-agent. No exceptions.

## Order

1. **Side-effect imports** — first, visibly isolated (one blank line after).
2. **Node built-ins** — `node:crypto`, `node:path`, etc.
3. **External packages** — `ai`, `hono`, `zod`. Excludes `@stagewise/**` workspace packages.
4. **Workspace packages** — `@stagewise/logger`, `@stagewise/config`.
5. **Internal aliases** — `@/config`, `@/model-provider`, `@/session/types`.
6. **Relative modules** — `./server`, `./utils/types`.

One blank line between groups. Sort module paths alphabetically within each group.

```ts
import './instrumentation';

import { randomUUID } from 'node:crypto';

import { type ServerType, serve } from '@hono/node-server';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import { createChatSession } from '@/session/chat';

import { createAdminApp } from './server';
```

## Style

- **One import declaration per source module.** Biome merges duplicates automatically.
- **`import type`** for entirely type-only modules: `import type { Config } from '@/config'`.
- **Inline `type`** for mixed value/type imports: `import { type ServerType, serve } from '@hono/node-server'`.
- **Never use a value import for a symbol used only as a type.** Use `import type` or inline `type`.
- **Never manually align imports with spaces.** Let the formatter handle spacing.

## barrel imports

- **Cross-module**: import through the barrel — `@/config`, `@/model-provider`.
- **Intra-module**: import internal dependencies directly — `./server`, `./utils/types`. Never import through your own module's barrel.
- **No import comments or subsection labels.** Blank lines between groups communicate structure.

## tooling — enforced by Biome

Biome config in `biome.jsonc` enforces all rules above automatically:

- **`useImportType`** rule (level `error`, style `auto`) — forces `import type` for type-only modules, inline `type` for mixed imports.
- **`organizeImports`** assist action — enforces group ordering, blank line separators, alphabetical sorting, and duplicate merging. Groups configured: bare → Node/Bun → external (excl `@stagewise/**`) → `@stagewise/**` → `:ALIAS:` → `:PATH:`.
- **`sortBareImports: true`** — side-effect imports are sorted. If side-effect order matters at runtime, keep filenames sortable or manage that section manually.

Run `pnpm check:fix` (→ `biome check . --write`) to auto-fix. CI runs `biome ci .` to verify without rewriting.

**Do not add a global `{ "type": true }` group.** That would create a separate type-import section instead of keeping imports grouped by dependency layer.
