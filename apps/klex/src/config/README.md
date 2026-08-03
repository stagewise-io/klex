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
