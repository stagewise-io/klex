# Klex configuration

Klex persists `config.json` in its data directory. The current configuration
format is version 2. Provider keys are stable configured-instance IDs; they are
used by model selections, Admin API operations, logs, and telemetry. The
provider `type` selects registry behavior. Multiple instances may use the same
type.

## Complete version 2 example

```json
{
  "configVersion": 2,
  "officialName": "Ada",
  "providers": {
    "openai-primary": {
      "type": "openai",
      "settings": {
        "apiKey": "${env:OPENAI_PRIMARY_KEY}"
      },
      "knownModels": {
        "gpt-4.1": {
          "displayName": "Primary GPT",
          "contextSize": 128000
        }
      }
    },
    "openai-secondary": {
      "type": "openai",
      "settings": {
        "apiKey": "${env:OPENAI_SECONDARY_KEY}"
      }
    },
    "openai-internal": {
      "type": "openai",
      "settings": {
        "baseUrl": "https://models.internal.example/v1",
        "apiKey": "${env:INTERNAL_OPENAI_KEY}",
        "headers": {
          "X-Tenant": "${env:INTERNAL_TENANT}"
        }
      }
    },
    "custom-chat": {
      "type": "chat-completions",
      "settings": {
        "baseUrl": "https://inference.example/v1",
        "apiKey": "${env:CUSTOM_API_KEY}"
      },
      "knownModels": {
        "org:model:v2": {
          "displayName": "Internal reasoning model",
          "contextSize": 65536,
          "capabilities": {
            "input": {
              "image": {
                "mediaTypes": ["image/png", "image/jpeg"],
                "maxBytes": 10000000
              }
            }
          }
        }
      }
    }
  },
  "modelSelection": {
    "chat": [
      {
        "providerId": "openai-primary",
        "modelId": "gpt-4.1"
      },
      {
        "providerId": "custom-chat",
        "modelId": "org:model:v2",
        "providerOptions": {
          "openai": {
            "reasoningEffort": "high"
          }
        }
      }
    ],
    "compaction": [
      {
        "providerId": "openai-secondary",
        "modelId": "gpt-4.1-mini"
      }
    ],
    "memory": [],
    "imageVision": [
      {
        "providerId": "custom-chat",
        "modelId": "org:model:v2"
      }
    ],
    "audioListening": [],
    "voice": {
      "sts": [],
      "tts": [],
      "stt": []
    }
  },
  "mcpServers": {},
  "telemetry": {
    "level": "reduced"
  }
}
```

`openai-primary` and `openai-secondary` demonstrate independent instances of
one provider type. `openai-internal` keeps native OpenAI behavior while routing
it to a configured internal endpoint. `custom-chat` is a single-endpoint
protocol adapter. Model IDs are never colon-parsed, so `org:model:v2` remains
intact.

`knownModels` is optional manual metadata. Automatic discovery is held only in
memory and is not written to this file. When discovery and `knownModels` return
the same exact model ID, manual fields override discovered fields. A model may
still be selected when it is absent from `knownModels`; callers receive a
warning rather than having the selection rejected.

## Model capability metadata

Provider model metadata is layered from lowest to highest precedence:

1. The shared open-model catalog supplies conservative metadata for model
   families reused across providers.
2. Provider-owned family and exact-model rules add authoritative metadata for
   the provider's API.
3. Live discovery may refine fields returned by the upstream model-list API.
4. `knownModels` is the user override and wins field by field.

Merging is deep for `capabilities`, so overriding one voice or input capability
does not discard unrelated catalog metadata. Arrays and scalar values are
replaced by the higher-precedence layer. Runtime model resolution and model
listing use the same merge policy. `provenance` identifies the contributing
layers (`shared-catalog`, `provider-family`, `provider-exact`, `discovered`, or
`user`).

`kind` identifies the model's primary operation: `language`,
`image-generation`, `embedding`, `reranking`, `moderation`,
`speech-to-speech`, `text-to-speech`, `speech-to-text`, or `unknown`. Models
with no authoritative classification remain unclassified; do not infer broad
capabilities from an opaque deployment name. Realtime, TTS, and STT selection
also requires the corresponding `capabilities.voice` flag.

Catalog maintenance policy:

- Prefer exact rules when capabilities vary within a family; use family rules
  only for stable, documented behavior.
- Record an upstream documentation URL and review date for maintained entries.
- Declare only capabilities confirmed by provider documentation or API
  metadata. Unknown values must remain absent rather than guessed.
- Keep provider-specific behavior in that provider's catalog. Add shared rules
  only for open model families whose behavior is portable across hosts.
- Update or add conformance tests for every changed family, exact model, model
  kind, context size, or media constraint.
- User overrides are never rewritten when catalogs change.

## Environment interpolation

Every string value supports one or more `${env:VARIABLE_NAME}` placeholders,
including placeholders embedded in URLs, headers, arrays, and nested provider
settings:

```json
{
  "baseUrl": "https://${env:MODEL_HOST}/v1/${env:TENANT}",
  "headers": {
    "Authorization": "Bearer ${env:INFERENCE_TOKEN}",
    "X-Combined": "${env:TENANT}:${env:REGION}",
    "X-Literal": "$${env:NOT_A_SECRET_REFERENCE}"
  }
}
```

Interpolation applies to values, never object keys. `$${env:NAME}` is the
literal escape and materializes as `${env:NAME}` at runtime. A referenced
variable that is not defined makes the configuration invalid; Klex never
substitutes an empty string. A version 2 document always retains its original
placeholders and escapes. Version 1 migration normalizes legacy `{env:NAME}`
references to `${env:NAME}`. Resolved values exist only in the runtime view and
must not be returned through the Admin API or written during later updates.

## Version 1 migration

A configuration without `configVersion: 2` is parsed as version 1 and migrated
once. Klex validates the complete result before atomically replacing the source
file.

- A preset provider becomes one typed instance and keeps its old provider ID.
- A manual provider with one endpoint becomes one protocol-adapter instance and
  keeps its old provider ID.
- A manual provider with multiple endpoints becomes one instance per endpoint,
  using deterministic `<provider>--<endpoint>` IDs.
- Every string model reference is rewritten to an explicit `{ "providerId",
  "modelId" }` object. Existing `providerOptions` are retained.
- Native model-ID colons are preserved.
- An instance-ID collision or a non-language-model legacy endpoint fails with an
  actionable migration error. No entry is silently overwritten or discarded.

After migration, the persisted document has `configVersion: 2`; subsequent
starts parse it directly and do not migrate it again.

## Realtime media

The realtime media slice is opt-in:

```json
{
  "realtime": {
    "mode": "disabled"
  }
}
```

Supported modes:

- `disabled` (default): Klex does not advertise Realtime Media, open realtime
  lifecycle listeners, or initialize LiveKit's native SDK.
- `loopback`: Klex advertises Realtime Media, accepts `livekit-room` offers, and
  returns the caller's 48 kHz mono PCM through a bounded diagnostic loopback
  processor.
- `openai-realtime`: Klex uses the same MCP and LiveKit path but sends audio to
  OpenAI Realtime over a server-to-server WebSocket.

OpenAI mode requires an explicit realtime model and an API key environment
reference. Do not store the key value in `config.json`:

```json
{
  "realtime": {
    "mode": "openai-realtime",
    "openai": {
      "model": "gpt-realtime-2.1",
      "apiKey": { "env": "OPENAI_API_KEY" },
      "voice": "marin",
      "instructions": "Answer clearly and briefly.",
      "serverVad": {
        "threshold": 0.5,
        "prefixPaddingMs": 300,
        "silenceDurationMs": 500
      }
    }
  }
}
```

The mode is resolved once during process startup. Restart Klex after changing it;
active MCP connections cannot renegotiate capabilities in place. The default
test suite is network-independent. Set `OPENAI_REALTIME_INTEGRATION=1` and
`OPENAI_API_KEY`, then run `pnpm test:openai-realtime` from `apps/klex` for the
opt-in provider connection check.

## MCP authentication

HTTP MCP servers automatically negotiate OAuth when they return an authorization
challenge. No Klex-specific authentication setting is required:

```json
{
  "mcpServers": {
    "accounting": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Klex also accepts `"type": "http"` and `"type": "streamable-http"` for
compatibility with MCP configurations used by other clients. An explicitly
configured `Authorization` header takes precedence and disables automatic OAuth.
OAuth is not used for stdio servers.

For non-Cloud authorization servers, Klex opens the provider consent page in the
system browser and accepts the callback on a temporary `127.0.0.1` port. This
flow is active regardless of cloud connectivity. If the browser cannot be opened,
Klex prints the consent URL for manual use. Authorization is canceled when Klex
shuts down and times out after five minutes. Tokens, client registration data,
PKCE material, and discovery state are stored with owner-only permissions in
`credentials/mcp-oauth.json` under the data directory; they are not written to
`config.json` or returned by the Admin API. Cloud-hosted authorization, where the
consent window and callback live in Klex Cloud instead of a local browser, is
planned; until then consent happens on the machine running Klex.

When cloud connectivity is enabled, Klex first follows the server's RFC 9728
protected-resource challenge. The advertised metadata URL must use HTTP(S), have
no embedded credentials, and share the configured MCP server's origin. If the
advertised authorization server exactly matches
`<configured-cloud-base-url>/api/auth`, Klex verifies that the metadata resource
exactly equals the configured MCP URL and that all challenged scopes are
supported. It then uses the enrolled machine identity to obtain an
audience-specific token. Hostname patterns are not trusted, so production and
preview deployments use the same issuer-based flow.

Trusted Cloud discovery requires enabled, enrolled Cloud connectivity. Klex
caches the validated discovery result and access token. A later 401 invalidates
the resource-specific token and retries once; a second 401 is returned without
another retry. Tokens are attached only to requests for the validated canonical
resource and never to metadata requests or foreign resources. Servers whose
issuer is not Klex Cloud fall through to the generic flow described above. The
Admin API exposes only sanitized lifecycle states (`authorization_required` and
`authorizing`), never authorization URLs, callback parameters, issuers, or
credentials.

A Klex Cloud MCP server is therefore configured with only its URL:

```json
{
  "mcpServers": {
    "slack": {
      "url": "https://cloud.klex.bot/api/integrations/slack/mcp"
    }
  }
}
```

Incoming Slack notifications use at-least-once delivery. Klex subscribes before
draining persisted events and deduplicates by `eventId`, so reconnecting after a
process or network interruption does not lose accepted Slack events.
