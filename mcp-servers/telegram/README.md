# Telegram MCP Server

An ephemeral, text-only Telegram bridge using grammY. Allowlisted private messages become Push Notifications; agents reply through one MCP tool.

## Start the proxy

The process starts without Telegram credentials:

```sh
pnpm --filter @stagewise/telegram dev
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8789` | HTTP port |
| `LOG_LEVEL` | `INFO` | Structured log threshold |
| `TELEGRAM_RUNTIME_IDLE_TIMEOUT_MS` | `5000` | Grace period before an unsubscribed runtime is destroyed |

`GET /health` is credential-free and reports only aggregate runtime counts. It never reports bot identities, tokens, allowlists, or runtime keys.

## Connect an agent

Every request to `http://localhost:8789/mcp` must include:

- `X-Telegram-Bot-Token`: the BotFather token. `Authorization: Bearer <token>` is also accepted.
- `X-Telegram-Allowed-User-Ids`: a comma-separated list of positive numeric Telegram user IDs.

Klex can resolve credentials from its environment without storing their values in configuration:

```json
{
  "transport": "http",
  "url": "http://localhost:8789/mcp",
  "headers": {
    "X-Telegram-Bot-Token": "{env:TELEGRAM_BOT_TOKEN}",
    "X-Telegram-Allowed-User-Ids": "{env:TELEGRAM_ALLOWED_USER_IDS}"
  }
}
```

Treat the bot token as a password. Send `/start` to the bot before expecting it to message a user. Telegram permits only one long-polling consumer per bot token.

## Runtime model

The proxy derives an opaque, process-local runtime key from each token. Distinct tokens receive isolated Telegram pollers, MCP handlers, event queues, acknowledgements, tools, and allowlists. Concurrent requests for the same token reuse one runtime and cannot start duplicate pollers.

An active Push Notifications subscription keeps its runtime alive. After the subscription disconnects, the runtime remains available for the configured grace period, then closes its MCP handler and Telegram poller and deletes its token, allowlist, pending events, and acknowledgement state. Reconnecting after cleanup creates a fresh runtime.

Requests using the same bot token intentionally share one runtime. The latest authenticated request replaces that runtime's allowlist, and only one active Push Notifications subscription is retained for its fixed internal consumer. Use distinct bot tokens when agents require isolation.

## Contract

Inbound events use `sourceId: "telegram:<botId>"` and type `chat.message.received`. The message body is a canonical MCP text block in `content`; `data` contains `messageId`, `updateId`, `chatId`, and `senderId`. Event IDs are deterministic from the bot and update IDs. This server currently emits only text content blocks.

Send text with:

```ts
await mcpClient.callTool({
  name: 'sendMessage',
  arguments: {
    chatId: '123456789',
    message: 'Hello',
    replyToMessageId: '42', // optional
  },
});
```

Messages must contain 1–4,000 characters. The outbound `chatId` must be in the runtime's current allowlist. Only allowlisted, non-bot, private plain-text messages are accepted; groups, media, edits, reactions, formatting, and webhooks are not supported.

## Pending queue guarantees

Pending retrieval is bounded and oldest-first. Acknowledgements are idempotent and immediately hide matching events. Duplicate Telegram updates are suppressed while the runtime exists, including after acknowledgement.

These guarantees are runtime-scoped, not durable. Destroying a runtime or restarting the proxy discards its queue and acknowledgement tombstones. A later runtime may therefore receive an upstream Telegram update again.
