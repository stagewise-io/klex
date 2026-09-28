# Klex Docs

The documentation site uses Blume 1.6.6. Run these commands from the repository root:

```sh
pnpm --filter docs run dev
pnpm --filter docs run doctor
pnpm --filter docs run build
```

## Optional PostHog analytics

Copy `apps/docs/.env.example` to `apps/docs/.env` for local configuration, or set
`POSTHOG_KEY` and `POSTHOG_HOST` in the docs build environment. Use the PostHog
project key and its ingestion host URL, not a personal API key. The example
contains no credentials.

`blume.config.ts` reads `process.env.POSTHOG_KEY` and
`process.env.POSTHOG_HOST`, trims whitespace, and enables Blume 1.6.6's
`analytics.posthog: { key, host }` only when both values are nonblank. If either
value is missing, empty, or whitespace-only, the analytics configuration is
omitted.

These values are consumed at build time and included in the public client output;
rebuild the docs after changing them. Keep local `.env` files untracked. This
configuration applies only to the docs site.
