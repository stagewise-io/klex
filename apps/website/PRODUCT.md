# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are teams at Series B-stage startups. They need digital coworkers to handle repeatable, time-consuming processes across software development and back-office work.

## Product Purpose

Klex is a fully autonomous digital coworker that performs repeatable work for startup teams. It is designed to run locally, remain easy to self-host, and give users an agent that works across their existing communication tools without requiring them to manage model sessions or orchestration machinery.

Success means teams can delegate recurring development and operational processes to Klex through familiar communication apps and experience it as one coherent coworker.

## Positioning

Klex is an open-source, locally running digital coworker whose environment boundary and communication model are built exclusively on MCP.

Its intended position is the first autonomous agent users can describe as “it just works”: one coherent actor that can operate across channels, machines, other agents, and model providers without exposing the underlying orchestration.

## Operating Context

Users communicate with Klex through familiar apps such as Slack, Discord, WhatsApp, and Telegram. Klex can participate in those conversations with humans, external agents, and other Klex agents in a human-like collaborative role.

Klex runs its durable brain, memory, configuration, and orchestration state locally. Outside channels, tools, work environments, browsers, and machines connect through MCP rather than running inside the core host.

## Capabilities and Constraints

- All communication and outside-environment access use MCP as the boundary.
- Klex is fully autonomous and sessionless from the user’s perspective.
- Klex preserves one durable identity and memory across channels, model runs, subagents, and machines.
- Klex supports multiple LLM providers and must not be positioned as exclusive to a particular provider.
- Klex can interact with humans and agents, including other Klex agents, in shared conversations.
- Klex must remain easy to self-host and capable of running locally.
- Product work must not claim support for an unverified channel, integration, platform, workflow, or deployment mode.

## Brand Commitments

- The product and agent are named **Klex**.
- The agent may also be called the **Klex Bot** or a **Bot**.
- Prefer the concrete category **digital coworker** over generic AI-assistant language.
- Open-source, local operation, self-hosting, autonomy, MCP, and model-provider independence are durable product commitments.
- The public website includes an attribution and link to stagewise.

## Evidence on Hand

- The repository architecture defines Klex as one durable agent across channels, model runs, subagents, and machines in `AGENTS.md`.
- Installation, local operation, supported desktop platforms, MCP-based environment access, self-improvement, sessionless routing, and model awareness are documented in the repository `README.md`.
- Existing Klex logos and icons are available under `assets/brand/`.
- The repository is licensed under Apache License 2.0.
- No customer names, testimonials, benchmarks, adoption figures, pricing, or proof for the “first” and “it just works” positioning claims are currently established. Future work must not fabricate them.

## Product Principles

1. **Feel like one coworker.** Users interact with Klex as one coherent actor, not as a collection of sessions, models, subagents, or tool calls.
2. **Meet teams where work already happens.** Communication belongs in familiar collaborative apps rather than a Klex-specific chat silo.
3. **Keep the core local and replaceable environments external.** Durable identity and memory stay with Klex; work environments connect through MCP.
4. **Remain provider-agnostic.** Choose models according to the work without binding the product to one model vendor.
5. **Make autonomy operationally simple.** Self-hosting and recurring delegation should support the product promise that Klex “just works.”
