# Klex configuration

Klex persists `config.json` in its data directory. The realtime media slice is
opt-in:

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

With `--no-cloud`, Klex opens the provider consent page in the system browser and
accepts the callback on a temporary `127.0.0.1` port. If the browser cannot be
opened, Klex prints the consent URL for manual use. Authorization is canceled
when Klex shuts down and times out after five minutes. Tokens, client
registration data, PKCE material, and discovery state are stored with owner-only
permissions in `credentials/mcp-oauth.json` under the data directory; they are
not written to `config.json` or returned by the Admin API.

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
resource and never to metadata requests or foreign resources.

For non-Cloud authorization servers, local browser authorization is deliberately
disabled while cloud connectivity is enabled. Their OAuth challenge leaves the
MCP server in `authorization_required`. With `--no-cloud`, the generic loopback
flow described above remains available. The Admin API exposes only sanitized
lifecycle states (`authorization_required` and `authorizing`), never
authorization URLs, callback parameters, issuers, or credentials.

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
