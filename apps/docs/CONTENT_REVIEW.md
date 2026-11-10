# Editorial fact-check plan

> Maintainer note for this draft PR. This file is not product documentation. Keep unsupported claims out of published pages.

## Confirmed directly by Glenn (30 Oct 2026)

- **Hosting:** Klex recommends a Cloud-hosted Bot. A Bot can also run in a user-managed environment and be enrolled in Klex Cloud; enrollment is not technically required for a self-hosted Bot, but the standalone experience is less complete. Self-hosted Cloud is available only to Enterprise customers.
- **Bot environment and work boundary:** The Bot's own environment is used only to manage memory and keep the Bot running. All work happens exclusively in other environments. Machines and MCP servers are connectors to those environments. Avoid describing machines or MCP servers as “tools” in reader-facing docs.
- **Data location and access:** Chats and memory are stored in the Bot's data directory: in the hosted environment for Cloud-hosted Bots, or locally for self-hosted Bots. Admins can access them through the Admin API. The Cloud dashboard acts as a reverse proxy and frontend for each Bot's Admin API.
- **Access management and stopping:** Users can review Bot activity in the dashboard and connect or disconnect MCP servers. For other connected apps and accounts, Glenn recommends configuring their permissions directly. A self-hosted Bot can be stopped by closing its app; a Cloud Bot can be stopped with the dashboard's Stop control.
- **Safety controls:** Action approvals and restrictions are not implemented today. Advanced tracking and behavioral-analysis tooling is planned; do not describe it as available, or publish roadmap details, without approval.

## Additional confirmations from Glenn (30 Oct 2026)

- **Connections:** A machine is connected through MCP. An MCP server can expose a full machine or an app; Klex offers built-in MCP servers and supports connecting other MCP servers.
- **Connection and identity:** An MCP connection is either connected or not. For most MCPs, a Bot acts through its own account or identity, configured per Bot with permissions and access grants. Do not invent a separate MCP-level permission model.
- **Current Memory:** Klex Bot Memory currently stores skills and learnings. Facts, individual people, and trust are planned, not confirmed as current capabilities.
- **Page structure and diagrams:** Keep Connections as its own page. Glenn approved the V4 Overview art style and colors as a reference for future docs illustrations; the vertical arrangement is not a prescribed layout. Use editable SVGs where appropriate.

## Additional confirmations from Glenn (9 Nov 2026)

- **Dashboard activity:** Users can see what the Bot is doing and chat with it in the dashboard. Glenn described the activity visibility as basically everything the Bot does; specific views and navigation have not been confirmed.
- **Cloud data encryption:** All Cloud-hosted Bot data, including memory, is encrypted in transit and at rest. Do not extend this claim to self-hosted Bots without confirmation.
- **Terminology:** Use “computer” rather than “machine” in reader-facing docs.
- **Memory scope:** Describe implemented capabilities only; do not include planned features in the Memory page.

## Confirmed from the repository; check release scope

- **Self-hosted diagnostics in Klex 0.30.1:** `main.ts` captures up to 500 entries in the interactive in-memory log store and enables console logging in headless mode. `cli-ui/screens/settings.tsx`, `log-viewer.tsx`, and `debug-information.tsx` define the menus, viewer controls, and displayed runtime and Cloud status. The display-level filter does not change logger capture settings. Verified against upstream `v0.30.1` at `baff8a40ce9b896fdd17146dfe9906cefe7c2697`.

- **Self-hosted health listener in Klex 0.30.1:** `cli/cli.ts` and `cli/cli.test.ts` define the optional port, CLI precedence, and default `0.0.0.0` host. `health-server/health-server.ts` serves unauthenticated exact GET `/livez` and `/readyz`; tests cover 200/503 lifecycle responses. `update-bootstrap/update-bootstrap.ts` starts it before loading the app; `application/application.ts` marks readiness after runtime startup and revokes it during drain or shutdown. This is not a model, connection, or task health check and does not expose the Admin API. The upstream `v0.30.1` tag was verified at `baff8a40ce9b896fdd17146dfe9906cefe7c2697`.

- **Self-hosted analytics and telemetry in Klex 0.30.1:** `cli/cli.ts` and its tests resolve product analytics separately from OTLP telemetry. Analytics are enabled by default when a build includes a PostHog key; `--no-analytics`, `KLEX_NO_ANALYTICS=1`, or `DO_NOT_TRACK=1` opt out, while an explicit `--analytics` overrides the environment. `product-analytics/schema.ts` defines the closed event properties; `product-analytics/product-analytics.ts` generates a per-process random ID. Analytics requests expose the sender IP to the recipient; do not assume the PostHog project discards it. Telemetry has no default endpoint and can be forced off with `--disable-telemetry` or `KLEX_DISABLE_TELEMETRY=1`. An endpoint defaults to advanced; debug can export chat content and tool payloads (`telemetry-config/telemetry-config.ts`, `telemetry.md`). Neither switch controls other network connections. Do not extrapolate to Cloud-side reporting.

- **Soul in Klex 0.30.1:** The self-hosted CLI has a Soul screen for viewing, creating, updating, and re-creating a soul from instructions (`apps/klex/src/cli-ui/screens/soul.tsx`). The Admin API provides GET, POST, and PATCH soul routes; POST and PATCH use one-shot model generation, not a god session (`apps/klex/src/admin-api/routes/v1/soul.ts`). Regular sessions have no soul-writing tool. God messages remain available in a dedicated session, but are not the only way to update the soul (`apps/klex/src/application/application.ts`). Do not claim ordinary conversations guarantee safety, or that the Cloud UI cannot display a soul without checking the current Cloud interface.

- **MCP in Klex 0.30.1:** The released source at `baff8a40ce9b896fdd17146dfe9906cefe7c2697` installs MCP ingress in the default session (`apps/klex/src/application/application.ts`). Its `addMcpServer` tool can add new remote HTTP(S) servers but not edit or remove existing ones (`apps/klex/src/session/chat/extensions/mcp-ingress/mcp-ingress.ts`, tests in the same directory). Resources and the push-notification extension are implemented in `apps/klex/src/mcp/connection.ts` and `apps/klex/src/mcp/architecture.md`; capabilities depend on the server. The release tag `v0.30.1` resolves to that commit. A switch controlling Bot-added servers remains unconfirmed; do not claim one exists.

- The provider-registry README lists 25 provider types, but the Klex 0.30.1 registry source also registers TypeSafe AI and Vercel AI Gateway (`apps/klex/src/provider-registry/providers/providers.ts`). The README is not an exhaustive model catalogue. Exact available models depend on the provider and configured account. TypeSafe’s native provider is for evaluation, not chat (`providers/typesafe-ai.ts`); don’t imply every provider supports every task.
- No single recommended model setup was found in the repository; Glenn has not yet confirmed model-selection advice.

- **Agent Skills in Klex 0.30.1:** `apps/klex/src/skills/skills.ts` stores each skill under `skills/{namespace}/{name}/SKILL.md` in the data directory. The skills extension exposes descriptions and a `readSkill` tool (`session/chat/extensions/skills/skills.ts`); the learning extension can create, update and remove learned skills. Admin routes list, read, update and delete qualified skills (`admin-api/routes/v1/skills.ts`). An admin edit is informational and does not prevent later learning changes. Do not infer automatic sharing between Bots from template support.

- **Messaging:** Glenn confirmed dashboard chat, connections via MCP, and that most Bots act through accounts with permissions configured in the app. In Klex 0.30.1, MCP ingress maps push events to the default session (`session/chat/extensions/mcp-ingress/push-notification-adapter.ts`), and the session prompt directs text replies to the originating MCP conversation (`session/chat/utils/system-prompt.md`). These are implementation and prompt behaviors, not guarantees of correct routing or identity recognition. No specific channel recommendation or exhaustive messaging-app support list has been confirmed.

- **Self-hosted data directory in Klex 0.30.1:** `cli/cli.ts` discovers Bots under `agents` in `KLEX_HOME` (default `~/.klex`); `--data-dir` overrides `KLEX_DATA_DIR`. `data-directory/data-directory.ts` requests mode `0700` for newly created directories, leaves existing permissions unchanged, and notes Windows uses ACLs. The directory can contain credentials. Do not infer a supported backup, migration, or restore procedure.

- **Enrollment token in Klex 0.30.1:** `cli/cli.ts` accepts `KLEX_CLOUD_ENROLLMENT_TOKEN` when no `--cloud-enroll-token` argument is present, including for `--create-bot`; tests in `cli/cli.test.ts` cover the environment fallback. Prefer an approved secret-management process and avoid showing literal tokens in shell commands.

- **Sessions in Klex 0.30.1:** `application/application.ts` installs MCP ingress in the default session and creates a separate god session. The consult extension can create temporary child sessions and report advice (`session/chat/extensions/consult/consult.ts` and `main-system-prompt.md`). Do not guarantee simultaneous request processing or specific completion times.

- **Activity API in Klex 0.30.1:** `admin-api/routes/v1/sessions.ts` lists persisted session instances and paginated messages; the message response reports `trimmedMessageCount`. `usage.ts` and `schemas.ts` expose model-call usage with time grouping and unreported-token counts. `admin-api/server.ts` serves `/v1/openapi.json`. `admin-api/admin-api.ts` binds the optional local port to `127.0.0.1` without authentication; it is not enabled by default. Do not claim the activity history is complete or that usage equals an invoice.

- **Reminders in Klex 0.30.1:** `session/chat/extensions/todos/todos.ts` implements one-shot reminder times; the system prompt directs the Bot to use calendars for official or recurring events (`todos/system-prompt.md`). The docs should not present built-in to-dos as recurring schedules or imply that a schedule guarantees task completion. Specific scheduling integrations and their available capabilities remain unconfirmed.

## Open questions: do not infer

- Memory behavior beyond current skills and learnings: how memories are created or recalled, scope across chats/channels, and user/admin controls. Also unconfirmed: retention, deletion, backups, and exact file layout.
- Cloud staff access, third-party/model-provider processing, provider credential storage, encryption details beyond the confirmed Cloud-hosted scope, and other security guarantees.
- Detailed limits or guarantees around sessions, identity, channel access, and connector permissions; how the Bot identifies the exact person speaking; channel recommendations; and how existing customers use Bots.
- Recommended model configuration, including primary/fallback or task-specific choices.
- Product claims in the Bot landing page, Soul, Identity, and MCP pages that are not recorded above. Verify claims about autonomy, Bot identity, memory format/access, and protocol behavior before carrying them into an overview or describing them as guaranteed.

## Drafting rule

Keep the page map and reader questions, but replace implementation detail with only confirmed behavior. Describe implemented capabilities only in published Memory documentation. For privacy, security, retention, and data-handling claims, record the confirming source or owner before publication.
