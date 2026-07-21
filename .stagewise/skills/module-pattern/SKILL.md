---
name: module-pattern
description: Rules for building, naming, and importing modules in fluid-agent. Use when creating modules, adding files to existing modules, writing cross-module imports, or setting up import paths.
---

# Module Pattern

Apply to every module in fluid-agent. No exceptions.

## File structure

Each module lives in its own folder. Two files are required:

1. **Named entry file** — same name as the folder. Contains all implementation (class, factory, interfaces, types).
2. **`index.ts` barrel** — re-exports all public symbols from the entry file. This is what consumers import from.

```text
config/
  config.ts      # implementation: ConfigModule, createConfig, Config interface
  config.test.ts # tests import from './config'
  types.ts       # internal type definitions (not re-exported unless public)
  index.ts       # export * from './config'; export * from './types';
```

- Entry file name = folder name. `config/config.ts`, not `config/index.ts`.
- `index.ts` only re-exports. No logic, no implementation.
- Tests sit next to the entry file: `config.test.ts`, not `index.test.ts`.
- Internal helpers within a module keep their own descriptive names (`server.ts`, `migrate.ts`).

## Import paths

- **Cross-module imports** use the `@/` alias + barrel: `from '@/config'`, `from '@/model-provider'`.
- **Intra-module imports** stay relative: `from './server'`, `from './types'`.
- Never bubble up relative paths (`../../config`) — use `@/` instead.

```ts
// Good — cross-module via alias + barrel
import { createConfig } from '@/config';
import type { ModelProvider } from '@/model-provider';

// Good — intra-module relative
import { createAdminApp } from './server';
import type { Config } from './config'; // within same module folder
```

## Infrastructure

The `@/` alias requires configuration in three places — all must stay in sync:

- `tsconfig.json`: `paths: { "@/*": ["./src/*"] }`. No `baseUrl` (TS 7+ removed it).
- `build.ts` (esbuild): `alias: { "@/": "./src/" }`.
- `vitest.config.ts`: `resolve.alias: { "@/": <src path> }`.

## Rules

1. **Implement each module as a class.**

2. **Instantiate modules only through a factory function.** Never `new` outside the factory.

3. **Factory returns the module's public handle** — the interface consumers use.

```ts
export interface AgentRuntime {
  start(): Promise<void>;
  run(input: AgentInput): Promise<AgentResult>;
  close(): Promise<void>;
}

class AgentRuntimeModule implements AgentRuntime {
  // implementation
}

export function createAgentRuntime(
  deps: AgentRuntimeDependencies,
): AgentRuntime {
  return new AgentRuntimeModule(deps);
}
```

4. **Keep implementation classes private** unless direct construction or extension is explicitly supported.

5. **Constructors only store configuration and dependencies.** Async initialization belongs in `start()`.

6. **Lifecycle-managed modules expose idempotent `start()` and `close()`.** Calling `start()` twice = no-op. Calling `close()` before `start()` = no-op.

7. **A module owns and closes only the child modules and resources it creates.** Injected dependencies are borrowed — never close them.

8. **Start owned children in dependency order. Close them in reverse order.**

9. **Clean up already-started children when startup fails.** Partial startup → rollback.

10. **Keep dependencies explicit.** No mutable global singletons.

11. **Module folder name = entry file name.** `admin-api/admin-api.ts`, `router/router.ts`. Entry file holds all implementation.

12. **`index.ts` barrel re-exports only public symbols.** No logic. Consumers import from the barrel (`@/config`), never directly from the entry file across modules.
