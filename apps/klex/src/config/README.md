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

The mode is resolved once during process startup. Restart Klex after changing it;
active MCP connections cannot renegotiate capabilities in place. Loopback is for
transport validation and is not the final realtime model integration.
