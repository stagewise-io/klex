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

## Cloud MCP authentication

HTTP MCP servers can opt into Klex Cloud authentication with `useCloudAuth`:

```json
{
  "mcpServers": {
    "slack": {
      "url": "https://cloud.klex.bot/api/integrations/slack/mcp",
      "useCloudAuth": true
    }
  }
}
```

Klex sends the first request without a Cloud token. After a `401` response, it
follows the server's RFC 9728 protected-resource challenge. The advertised
metadata URL must use HTTP(S), contain no credentials, and share the configured
MCP server's origin. The authorization server must exactly match the configured
Klex Cloud issuer, and the metadata resource must exactly match the configured
MCP URL. Klex then uses its enrolled machine identity to obtain a
resource-specific token with the challenged scopes.

Cloud authentication requires enabled, enrolled Cloud connectivity. Klex caches
the validated discovery result and access token. A later `401` invalidates the
resource-specific token and retries once. Tokens are attached only to requests
for the validated canonical resource and never to metadata requests, redirects,
or foreign resources. Stdio MCP servers do not use Cloud authentication.
