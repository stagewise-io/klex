# Langdock

Add a provider with type `langdock` in the CLI's **Gateways & plans** group.
Settings require `apiKey`; `region` is `eu` (default) or `us`. Optional `baseUrl`
overrides `https://api.langdock.com`, and `headers` supplies custom headers.
API keys and headers are treated as secrets. Environment references work as with
other providers. A base URL already ending in a protocol/region/version path is
normalized to the gateway root; the configured region determines all requests.

```json
{
  "type": "langdock",
  "settings": {
    "apiKey": "${env:LANGDOCK_API_KEY}",
    "region": "eu"
  }
}
```

Discovery queries OpenAI Chat Completions, Anthropic Messages and Google Gemini
concurrently. Anthropic and Google pagination are supported. A failing protocol
does not hide models from working protocols, and partial refreshes retain cached
models. Connectivity checks only list models. Every route uses Bearer
authentication, including Google (no API key in the URL).

Discovered custom IDs use their discovery protocol. For manual selections,
Claude IDs use Anthropic, Gemini IDs use Google, and other IDs use OpenAI Chat
Completions. Prefix an ID with `openai/`, `anthropic/`, or `google/` to select a
protocol explicitly. Colliding catalog IDs expose protocol-qualified aliases;
the unqualified default follows OpenAI, Anthropic, then Google catalog order.
Google tool schemas, remote media and `$ref` tool results retain Klex's input
adaptations. Anthropic retains prompt caching.

Routing is ephemeral: a module-private `WeakMap` associates each raw discovered
model object with its protocol and upstream ID. The registry's existing
settings-scoped model cache owns those objects and exposes a snapshot lookup in
provider context. Partial-cache merges retain the original objects, so routing
survives cached discovery and failed refreshes. Changes to credentials, headers,
region or base URL invalidate lookup through the existing settings signature.
No provider-specific fields enter `ProviderModel`, config, or API responses, and
discarded snapshots can be garbage-collected. After restart, discover custom IDs
again or use explicit prefixes for manual selections.

Config storage advances from schema 12 to 13, compatibility 8, minimum Klex
0.36.0 (preserved). The released v12 baseline was verified against
`v0.37.1-nightly20261117c001`; its migration files are unchanged. The new frozen
transition validates both versions and preserves the valid v12 payload.
Existing configs need no manual recovery. Older binaries reject
v13 during local-data preflight.
