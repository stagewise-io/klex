---
name: module-pattern
description: Rules for building modules in fluid-agent. Use when creating, reviewing, or refactoring modules, services, or lifecycle-managed components.
---

# Module Pattern

Apply to every module in fluid-agent. No exceptions.

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
