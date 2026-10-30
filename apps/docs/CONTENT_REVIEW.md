# Editorial fact-check plan

> Maintainer note for this draft PR. This file is not product documentation. Keep unsupported claims out of published pages.

## Confirmed directly by Glenn (30 Oct 2026)

- **Hosting:** Klex recommends a Cloud-hosted Bot. A Bot can also run in a user-managed environment and be enrolled in Klex Cloud; enrollment is not technically required for a self-hosted Bot, but the standalone experience is less complete. Self-hosted Cloud is available only to Enterprise customers.
- **Architecture:** Inside a Bot, the relevant internal functions are memory and active-session management. The Bot performs work through tools connected to external environments, such as computers and MCPs; those tools do not operate on the Bot's own environment.
- **Data location and access:** Chats and memory are stored in the Bot's data directory: in the hosted environment for Cloud-hosted Bots, or locally for self-hosted Bots. Admins can access them through the Admin API. The Cloud dashboard acts as a reverse proxy and frontend for each Bot's Admin API.
- **Access management and stopping:** Users can review Bot activity in the dashboard and connect or disconnect MCPs. For other connected apps and accounts, Glenn recommends configuring their permissions directly. A self-hosted Bot can be stopped by closing its app; a Cloud Bot can be stopped with the dashboard's Stop control.
- **Safety controls:** Action approvals and restrictions are not implemented today. Advanced tracking and behavioral-analysis tooling is planned; do not describe it as available, or publish roadmap details, without approval.

## Confirmed from the repository; check release scope

- The provider-registry README lists 25 provider types. It describes provider types and model discovery, not a fixed exhaustive model catalogue. Exact available models depend on the provider and configured account.
- Source also registers TypeSafe AI and Vercel AI Gateway, but `apps/klex/src/local-data/architecture.md` describes those provider types as unreleased and says config/model-call changes first ship in 0.18.0. Do not describe them as currently available without release confirmation.
- No single recommended model setup was found in the repository; Glenn has not yet confirmed model-selection advice.

## Open questions: do not infer

- Memory-selection/consolidation behavior, chat retention, deletion, backups, and exact file layout.
- Cloud staff access, third-party/model-provider processing, provider credential storage, and security/encryption guarantees.
- Detailed limits or guarantees around sessions, identity, channel access, and tool permissions.
- Recommended model configuration, including primary/fallback or task-specific choices.

## Drafting rule

Keep the page map and reader questions, but replace implementation detail with only confirmed behavior. Separate current capabilities from plans. For privacy, security, retention, and data-handling claims, record the confirming source or owner before publication.
