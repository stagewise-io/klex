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

## MCP OAuth

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

When cloud connectivity is enabled, local browser authorization is deliberately
disabled. An OAuth challenge leaves the MCP server in
`authorization_required`. A future cloud callback adapter will complete that
flow through the enrolled-agent channel; this release does not add a callback
route or transport for it. The Admin API exposes only sanitized lifecycle states
(`authorization_required` and `authorizing`), never authorization URLs, callback
parameters, issuers, or credentials.
