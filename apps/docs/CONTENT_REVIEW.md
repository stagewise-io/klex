# Editorial fact-check plan

> Maintainer note for this draft PR. This is not a source of product truth and is not part of the published docs. Do not convert unanswered questions into product claims.

## Confirmed direction from Glenn

The rewrite should help readers: get started with agents; understand how Klex Bots compare with other agents and how to migrate; identify useful applications; and operate multiple bots effectively. Glenn's question list also calls for coverage of architecture, memory, models, MCP and Agent Skills, channels, Cloud versus local use, reliability, permissions, privacy, security, and collaboration. These are topics to answer—not evidence of how the product behaves.

## Product facts to confirm before publication

- **Audience and positioning:** primary reader, first-session outcome, approved definition and terminology, validated customer use cases, and supportable product comparisons.
- **Setup and architecture:** exact first-bot setup for hosted and local use; supported runtime/sandbox options; what the bot, host, machine, MCP server, channel, and skills can access; and default permissions.
- **Memory, identity, and models:** memory behavior and persistence; how people are identified across channels; Agent Skills support; model/provider support; why multiple models may be needed; and recommended configuration.
- **Operations:** availability and wake behavior; recurring tasks; concurrency and parallel work; bot/channel limits; how to inspect, pause, stop, and recover; chat grouping; and update compatibility.
- **Trust and data handling:** where hosted and local prompts, memory, credentials, logs, and task data are stored or processed; third-party processors; Stagewise access; security controls and their limits; approved permission guidance; self-hosting availability; and guarantees we must not make.
- **Company workflows:** how bots communicate or collaborate, whether there is a recommended platform, how many bots to use, and which customer examples are approved for publication.

## Draft sections needing a fact-check pass

Before publication, review the claims and descriptions in `docs/bot/concepts/`, `docs/bot/guides/`, `docs/bot/reliability/`, `docs/cloud/`, and `docs/guides/`. In particular, the current English drafts describe implementation details and make claims about memory/session behavior, MCP access, identity, bot isolation, Cloud enrollment and credentials, privacy, security controls, availability, updates, and self-hosting. Treat those as unverified until Glenn or the responsible product owner confirms them. The pages marked “This answer is being written” are outlines, not answers.

## Coverage gaps to resolve

The current page map does not yet provide verified guidance for other sandbox providers, a recommended chat platform, approved customer examples, or the specific first-session success criteria. Confirm whether each should be answered, deferred, or intentionally out of scope.

## Working rule

Keep the information architecture and questions; publish product behavior only after confirmation. For privacy, security, data handling, availability, and product comparisons, record the source or owner who confirmed the wording.
