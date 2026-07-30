# WORKSPACE: klex

## SNAPSHOT

type: monorepo  
langs: TypeScript  
runtimes: Node.js ≥22.12.0  
pkgManager: pnpm@10.30.3  
deliverables: klex app, computer MCP server, shared libraries  
rootConfigs: turbo.json, pnpm-workspace.yaml, tsconfig (base.json)

---

## PACKAGES

| name | path | type | deps | usedBy | role |
|------|------|------|------|--------|------|
| @stagewise/klex | apps/klex | app | logger, libsql, drizzle, hono, zod | — | Self-improving orchestrator entrypoint |
| @stagewise/computer | mcp-servers/computer | service | logger, @modelcontextprotocol/* | — | Dual-era MCP server for computer tasks |
| @stagewise/logger | packages/logger | lib | tslog | klex, computer | Structured logging wrapper |
| @stagewise/mcp-ws-transport | packages/mcp-ws-transport | lib | @modelcontextprotocol/sdk, ws | — | WebSocket transport for MCP |
| @stagewise/mcp-extension-push-notifications | packages/mcp-extension-push-notifications | lib | @modelcontextprotocol/sdk | — | Durable events extension spec+schemas |
| @stagewise/typescript-config | packages/typescript-config | config | — | all | Shared TypeScript base configuration |

---

## DEPENDENCY GRAPH

apps/klex → packages/logger, packages/typescript-config  
mcp-servers/computer → packages/logger, packages/typescript-config  
packages/logger → packages/typescript-config  
packages/mcp-ws-transport → packages/typescript-config  
packages/mcp-extension-push-notifications → packages/typescript-config  

---

## ARCHITECTURE

### @stagewise/klex (`apps/klex`)

entry: src/main.ts → createLogger, createConfig, createAdminApi → shutdown handlers  
routing: src/admin/routes/v1/ → config, health  
state: src/config/config.ts → KlexConfig (models, MCP servers)  
api: Hono server on :2706 admin API  
db: Drizzle ORM with LibSQL  
auth: Zod-validated config  
build: esbuild (ESM or CJS/SEA) via build.ts  
dirs: `src/admin/` routes, `src/config/` config mgmt, `src/utils/sqlite/` DB layer

### @stagewise/computer (`mcp-servers/computer`)

entry: src/index.ts → McpHandler + Hono app  
api: MCP over HTTP (/mcp endpoint)  
routing: Dual-era (2026-07-28 modern + legacy stateless)  
build: esbuild (ESM)  
env: PORT (default 3123), LOG_LEVEL

### @stagewise/logger (`packages/logger`)

exports: createLogger(opts?: LoggerOptions) → RootLogger  
consumedBy: klex, computer  
basis: tslog with structured mask (password, apiKey, token, prompt)  
types: RootLogger, ModuleLogger, LogLevel, LoggerOptions

### @stagewise/mcp-extension-push-notifications (`packages/mcp-extension-push-notifications`)

exports: PushNotification, GetEventsRequest, AcknowledgeEventsRequest, PushNotificationNotification, PushNotificationsExtensionCapability  
protocol: io.stagewise/push-notifications  
core ops: `/get` (paginated retrieval), `/ack` (acknowledge), `/notifications/event` (push)  
builds: TypeScript source → ts-to-zod → Zod schemas + JSON Schema  
test: Conformance via vitest  
source: schema/draft/schema.ts (authoritative type definitions)  

### @stagewise/mcp-ws-transport (`packages/mcp-ws-transport`)

exports: WebSocketTransport  
basis: @modelcontextprotocol/sdk + ws  

---

## STACK

@stagewise/klex → framework: Hono, db: Drizzle+LibSQL, state: Zod, runtime: Node/esbuild  
@stagewise/computer → framework: Hono+@modelcontextprotocol/hono, routing: Express-like handler, runtime: Node  
@stagewise/logger → logging: tslog, export: CJS+ESM  
@stagewise/mcp-extension-push-notifications → schema: TypeScript→Zod→JSON, validation: ts-to-zod  

---

## STYLE

- esm-first: "type": "module" root + all packages
- typing: strict mode, noUncheckedIndexedAccess
- patterns: factory functions (createLogger, createConfig, createAdminApi)
- errors: custom error classes (ConfigValidationError)
- logging: structured, field-based via tslog
- module: subdirs by domain (admin/, config/, utils/)
- tests: vitest, *.test.ts suffix
- validation: Zod schemas, source-of-truth TypeScript definitions

---

## STRUCTURE

`apps/` → Deliverable applications  
`mcp-servers/` → MCP protocol implementations  
`packages/` → Shared libraries and configs  
`.stagewise/` → Workspace tooling  
`.husky/` → Pre-commit lifecycle  

---

## BUILD

workspaceScripts: build, dev, prepare, check, check:fix, typecheck, test  

| package | script | purpose |
|---------|--------|---------|
| klex | build | esbuild bundle to dist/main.js |
| klex | build:exe | esbuild CJS + SEA packaging |
| klex | dev | tsx watch src/main.ts |
| computer | build | esbuild bundle |
| computer | dev | tsx watch src/index.ts |
| computer | start | node dist/index.js |
| mcp-extension-push-notifications | generate:schemas | TypeScript→Zod+JSON Schema |
| mcp-extension-push-notifications | check:schema | Verify schema.json is current |
| mcp-ws-transport | test | vitest conformance |

envFiles: none at root  
envPrefixes: PORT, LOG_LEVEL  
ci: none defined  

---

## LOOKUP

add klex route → apps/klex/src/admin/routes/v1/*, apps/klex/src/admin/server.ts  
add klex config property → apps/klex/src/config/config.ts, update tests  
add MCP extension request/notification → packages/mcp-extension-push-notifications/schema/draft/schema.ts, run generate:schemas, add conformance test  
verify Klex Events schema compliance → packages/mcp-extension-push-notifications/tests/schema.test.ts  
regenerate Zod+JSON schemas → packages/mcp-extension-push-notifications/scripts/generate-schemas.ts  
add logger mask field → packages/logger/src/index.ts (LoggerOptions.mask.keys)  
add computer MCP tool → mcp-servers/computer/src/index.ts  
add workspace dependency → package.json, pnpm-workspace.yaml  

---

## KEY FILES

`package.json` → workspace root, scripts (build, dev, test, check, typecheck)  
`pnpm-workspace.yaml` → package discovery (apps/*, packages/*, mcp-servers/*)  
`turbo.json` → task cache, dependencies (build→^build, test→^build)  
`biome.jsonc` → linting/formatting rules  
`commitlint.config.js` → conventional-commits validation  

`apps/klex/src/main.ts` → app entry, lifecycle management  
`apps/klex/src/admin/admin-api.ts` → HTTP server factory (Hono, :2706)  
`apps/klex/src/config/config.ts` → config lifecycle, model resolution, validation  
`apps/klex/build.ts` → esbuild config, ESM vs CJS/SEA  

`mcp-servers/computer/src/index.ts` → MCP server entry, dual-era handler  

`packages/logger/src/index.ts` → createLogger factory, RootLogger type, mask config  

`packages/mcp-extension-push-notifications/schema/draft/schema.ts` → SOURCE TypeScript definitions (run generate:schemas after changes)  
`packages/mcp-extension-push-notifications/schema/draft/schema.json` → committed JSON Schema (auto-generated, DO NOT edit)  
`packages/mcp-extension-push-notifications/schema/draft/generated/schema.ts` → committed Zod schemas (auto-generated, DO NOT edit)  
`packages/mcp-extension-push-notifications/specification/draft/events.md` → Klex Events protocol spec  
`packages/mcp-extension-push-notifications/tests/schema.test.ts` → conformance tests for all protocol operations  
`packages/mcp-extension-push-notifications/scripts/generate-schemas.ts` → ts-to-zod build script, post-processing, JSON Schema export  

`packages/typescript-config/base.json` → strict mode, ES2022, bundler resolution, shared across all packages  

---

## NOTES

- Klex Events extension: durable env events via MCP, at-least-once delivery, client deduplication by eventId
- Schema generation: TypeScript definitions (source of truth) → Zod validators → JSON Schema (both exported)
- Computer MCP: Dual-era support (2026-07-28 modern factory-per-request, legacy 2025 stateless fallback)
- Admin API: Separate HTTP server (:2706) from main agent process
- Build artifacts: dist/, schema/draft/generated/ — gitignored except schema/draft/schema.json
- Node 22+ required; TypeScript strict, no any, ESM-only
