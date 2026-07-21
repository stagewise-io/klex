# Telegram MCP Server

Minimal text-only Telegram bot channel using grammY. Allowlisted private messages become Fluid Events; agents reply through one MCP tool.

## Setup

Create a bot with `@BotFather`, then run:

```sh
TELEGRAM_BOT_TOKEN='123:secret' \
TELEGRAM_ALLOWED_USER_IDS='123456789' \
pnpm --filter @stagewise/telegram dev
```

Treat the token as a password. Before starting this server, send `/start` to the bot and retrieve one update directly from the Bot API:

```sh
read -s TELEGRAM_BOT_TOKEN
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
unset TELEGRAM_BOT_TOKEN
```

Use the numeric `result[].message.from.id` value for `TELEGRAM_ALLOWED_USER_IDS`. Do not run `getUpdates` while this server is polling: Telegram permits only one update consumer per bot token. A user must send `/start` before the bot can DM them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | BotFather token |
| `TELEGRAM_ALLOWED_USER_IDS` | required | Comma-separated numeric sender IDs |
| `PORT` | `8789` | HTTP port |
| `LOG_LEVEL` | `INFO` | Structured log threshold |

Use `http://localhost:8789/mcp`. `GET /health` reports `starting`, `connected`, or `disconnected`.

## Contract

Inbound events use `sourceId: "telegram:<botId>"`, type `chat.message.received`, and payload fields `messageId`, `updateId`, `chatId`, `senderId`, and `message`. Event IDs are deterministic from the bot and update IDs.

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

Messages must contain 1–4,000 characters. Outbound `chatId` must also appear in `TELEGRAM_ALLOWED_USER_IDS`; this text-only private-DM server cannot message arbitrary chats.

## Deliberate limits

Only allowlisted, non-bot, private plain-text messages are accepted. Groups, media, commands, formatting, webhooks, edits, reactions, retries, and multiple bots are unsupported. The event feed is in memory and disappears on restart. Long polling permits only one running consumer per bot token.
