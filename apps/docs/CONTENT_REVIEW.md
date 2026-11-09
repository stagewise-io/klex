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

- **MCP in Klex 0.30.1:** The released source at `baff8a40ce9b896fdd17146dfe9906cefe7c2697` installs MCP ingress in the default session (`apps/klex/src/application/application.ts`). Its `addMcpServer` tool can add new remote HTTP(S) servers but not edit or remove existing ones (`apps/klex/src/session/chat/extensions/mcp-ingress/mcp-ingress.ts`, tests in the same directory). Resources and the push-notification extension are implemented in `apps/klex/src/mcp/connection.ts` and `apps/klex/src/mcp/architecture.md`; capabilities depend on the server. The release tag `v0.30.1` resolves to that commit. A switch controlling Bot-added servers remains unconfirmed; do not claim one exists.

- The provider-registry README lists 25 provider types. It describes provider types and model discovery, not a fixed exhaustive model catalogue. Exact available models depend on the provider and configured account.
- Source also registers TypeSafe AI and Vercel AI Gateway, but apps/klex/src/local-data/architecture.md describes those provider types as unreleased and says config/model-call changes first ship in 0.18.0. Do not describe them as currently available without release confirmation.
- No single recommended model setup was found in the repository; Glenn has not yet confirmed model-selection advice.

## Open questions: do not infer

- Memory behavior beyond current skills and learnings: how memories are created or recalled, scope across chats/channels, and user/admin controls. Also unconfirmed: retention, deletion, backups, and exact file layout.
- Cloud staff access, third-party/model-provider processing, provider credential storage, encryption details beyond the confirmed Cloud-hosted scope, and other security guarantees.
- Detailed limits or guarantees around sessions, identity, channel access, and connector permissions.
- Recommended model configuration, including primary/fallback or task-specific choices.
- Product claims in the Bot landing page, Soul, Identity, and MCP pages that are not recorded above. Verify claims about autonomy, Bot identity, memory format/access, and protocol behavior before carrying them into an overview or describing them as guaranteed.

## Drafting rule

Keep the page map and reader questions, but replace implementation detail with only confirmed behavior. Describe implemented capabilities only in published Memory documentation. For privacy, security, retention, and data-handling claims, record the confirming source or owner before publication.
