---
name: logger
description: Rules for using tslog v5 in klex. Use when creating, modifying, or reviewing logging code, module factories, or logger configuration.
---

# Logger Rules

Apply to all logging in klex. No exceptions.

## Types

- **Root logger** — `tslog` `Logger<ILogObj>`. Created once per process. Owns config: level, format, masking, transports.
- **Module logger** — restricted type alias. No wrapping, no adapters.

```ts
export type ModuleLogger = Pick<
  Logger<ILogObj>,
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
>;
```

## Rules

1. **One root logger per process.** Create in `main.ts` before all other modules.

2. **Configure global level, formatting, masking, and transports only in the logging module** (`logger.ts`). Never inside modules.

3. **Pass root logger into module factories as `logging`.** Factory creates one named child logger and injects it into the implementation class.

```ts
export function createAdminApi(deps: AdminApiDependencies): AdminApi {
  return new AdminApiModule({
    logger: deps.logging.child({
      name: 'admin-api',
      bindings: { module: 'admin-api' },
    }),
  });
}
```

4. **Modules store the injected child logger and call it directly.** Constructor stores deps — no async init.

5. **Do not wrap logger methods in custom adapter methods.** Use the actual `tslog` logger through `ModuleLogger` so source locations point to the real call site.

6. **No global logger imports inside modules.** All logger deps explicit via constructor.

7. **Create child loggers only for stable scopes** (modules, long-lived components). Not per log call.

8. **Structured fields for searchable data. Messages stable.**

```ts
logger.info({ port, host }, 'AdminAPI listening');
```

9. **Pass `Error` objects directly.** Use consistent field name.

```ts
logger.error({ error, context }, 'Request failed');
```

10. **Use async logging context for request/session/trace/user IDs.** Do not manually pass through every method.

11. **Never log credentials, auth headers, tokens, prompts, or model responses.** Configure global masking as second line of defence.

12. **Modules borrow their logger.** Never change global level, attach transports, flush, or dispose.

13. **Create root logger before all other modules. Dispose after all stopped.**

14. **Pretty output for local dev. JSON for deployed environments.**

15. **Prefer JSON on stdout with external collector.** In-process transports only where runtime requires.
