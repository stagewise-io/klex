# Klex Cloud

The `klex-cloud` type connects a bot to the Klex Cloud AI gateway with one
provider entry and one per-bot `sk_sw_` gateway token. Klex Cloud writes it for
managed bots; the CLI lists it under **Gateways & plans**. Use a provider ID with
the `stagewise-managed-` prefix (for example `stagewise-managed-cloud`) so
Cloud's managed-inference guards apply.

```json
{
  "type": "klex-cloud",
  "displayName": "Klex Cloud",
  "settings": {
    "baseUrl": "https://gateway.example/v1",
    "apiKey": "sk_sw_…",
    "protocols": {
      "openai/gpt-audio-mini": "chat-completions",
      "anthropic/claude-sonnet-5": "anthropic-messages"
    }
  }
}
```

| Setting | Required | Notes |
| --- | --- | --- |
| `baseUrl` | Yes | Literal URL including `/v1`. Environment references are rejected, so an environment change cannot send the token to another endpoint. |
| `apiKey` | Yes | Gateway token, sent as `Authorization: Bearer`. Secret. |
| `protocols` | No | Map from exact model ID to `responses`, `chat-completions`, `anthropic-messages` or the reserved `openai-live`. |
| `realtimeBaseUrl` | No | Reserved, unused. Literal URL. |

There is no `headers` setting.

## Routing

Each model uses exactly one protocol, chosen in this order:

1. `settings.protocols[modelId]` (exact, case-sensitive match).
2. Name rules: `gpt-audio` and `gpt-audio-*`, with or without a vendor prefix,
   use Chat Completions. `anthropic/*` and `claude-*` use Anthropic Messages.
3. Everything else uses Responses.

| Protocol | Adapter | Request |
| --- | --- | --- |
| `responses` | `createOpenResponses` | `POST {baseUrl}/responses` |
| `chat-completions` | `createOpenAICompatible` | `POST {baseUrl}/chat/completions` |
| `anthropic-messages` | `createAnthropic({ authToken })` with prompt caching | `POST {baseUrl}/messages` |

Discovery never affects routing. Its cache is filled only when models are
listed and is lost on restart, so routing from it could switch a model's wire
format in the middle of a session. Model IDs are sent unchanged
(`openai/gpt-6-luna`). The name rules assume OpenRouter-style IDs; use
`protocols` for any other naming.

All adapters use the `klex-cloud` provider-options namespace, so
`providerOptions['klex-cloud']` applies to every protocol. Anthropic Messages
also reads `providerOptions.anthropic`. Effort control stays `unknown`, as for
the `responses` type.

## Discovery and metadata

`GET {baseUrl}/models` lists models and backs connectivity checks; neither runs
inference. The gateway returns only `id`, `object`, `created` and `owned_by`,
so other metadata comes from Klex's OpenAI and Anthropic catalogs (by vendor
prefix) and the provider's `knownModels`. IDs matching the shared
non-language filter (embedding, TTS, Whisper, `realtime`, moderation and image
models) are left out of the list.

## Reserved realtime fields

Schema 14 reserves the live voice surface so adding managed voice later does
not need another config schema version:

- `openai-live` is an accepted `protocols` value, intended for `gpt-live-*`.
- `realtimeBaseUrl` is an accepted optional literal URL. It is read-only in
  setup forms.

Both validate and persist, but nothing reads them. A model mapped to
`openai-live` cannot be used for language generation. Realtime speech still
requires an `openai` or `google-gemini` provider, so `klex-cloud` is rejected
for `modelSelection.voice.sts`.

## Config storage

Config storage advances from schema 13 to 14, compatibility 8, minimum Klex
0.36.0 (preserved, as for schemas 12 and 13). The released v13 baseline is
`v0.38.2-nightly20261125c001`; its migration files are unchanged. The new
frozen transition validates both versions and preserves the valid v13 payload.
Existing configs need no manual recovery. Older binaries reject v14 during
local-data preflight.
