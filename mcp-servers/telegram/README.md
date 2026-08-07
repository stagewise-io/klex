# Telegram MCP Server

An ephemeral Telegram bridge using grammY. Allowlisted private text, photo, audio, and voice messages become Push Notifications; agents reply through text, voice, and photo MCP tools, manage their bot profile, and query pending inbound messages.

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
| `TELEGRAM_MEDIA_MAX_BYTES` | `10485760` | Maximum decoded bytes accepted for one media file |
| `TELEGRAM_PENDING_MEDIA_MAX_BYTES` | `52428800` | Maximum decoded media bytes retained by one runtime's pending queue |
| `TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS` | `15000` | Deadline for Telegram file lookup and download |

All size and timeout settings must be positive integers. `GET /health` is credential-free and reports only aggregate runtime counts. It never reports bot identities, tokens, allowlists, or runtime keys.

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

An active Push Notifications subscription keeps its runtime alive. After the subscription disconnects, the runtime remains available for the configured grace period, then closes its MCP handler and Telegram poller and deletes its token, allowlist, pending event bodies, media byte accounting, and deduplication tombstones. Reconnecting after cleanup creates a fresh runtime.

Requests using the same bot token intentionally share one runtime. The latest authenticated request replaces that runtime's allowlist, and only one active Push Notifications subscription is retained for its fixed internal consumer. Use distinct bot tokens when agents require isolation.

## Inbound contract

Inbound events use `sourceId: "telegram:<botId>"` and type `chat.message.received`. `data` always contains `messageId`, `updateId`, `chatId`, and `senderId`. Event IDs are deterministic from the bot and update IDs.

Supported allowlisted, non-bot, private messages are:

- Plain text as one MCP text content block.
- Photos as an inline base64 MCP image block with `image/jpeg` MIME type. The largest Telegram photo variant is selected.
- Telegram audio as an inline base64 MCP audio block using its declared `audio/*` MIME type.
- Telegram voice as an inline base64 MCP audio block, defaulting to `audio/ogg` when Telegram omits the MIME type.

A non-empty media caption is a text block immediately before the media block. Each Telegram update is one notification. Album/media-group entries remain independent notifications and are not aggregated.

Successful media events add `mediaKind`, `mediaStatus: "included"`, and `mediaSize` to `data`. Media that exceeds a limit, has an unsupported MIME declaration, fails to download, or exceeds the runtime's pending-media budget becomes a small text-only notification instead. Its `mediaStatus` is one of:

- `omitted_too_large`
- `omitted_unsupported_type`
- `omitted_download_failed`
- `omitted_queue_budget`

Documents, video, video notes, animation, stickers, edits, reactions, groups, and webhooks are not supported. Current Klex model conversion preserves notifications but drops non-text content before model invocation; agent-side image/audio understanding is a separate change.

Treat received content, base64 data, MIME declarations, captions, and structured data as untrusted input. Bot tokens, Telegram file identifiers, file paths, and credential-bearing download URLs are never emitted in notifications, MCP results, or logs.

## Outbound text

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

Messages must contain 1–4,000 characters. The outbound `chatId` must be in the runtime's current allowlist.

## Outbound voice

Send a voice message (OGG/OPUS) with:

```ts
await mcpClient.callTool({
  name: 'sendVoice',
  arguments: {
    chatId: '123456789',
    voiceData: base64EncodedOgg, // base64-encoded audio bytes
    caption: 'Transcript',        // optional, 1–1,024 chars
    duration: 10,                 // optional, seconds (0–3,600)
    replyToMessageId: '42',       // optional
  },
});
```

Voice data must be 1–50 MB of decoded bytes, base64-encoded. The outbound `chatId` must be in the runtime's current allowlist.

## Outbound photos

Send a photo with:

```ts
await mcpClient.callTool({
  name: 'sendPhoto',
  arguments: {
    chatId: '123456789',
    photoData: base64EncodedJpeg, // base64-encoded image bytes
    caption: 'Caption',           // optional, 1–1,024 chars
    replyToMessageId: '42',       // optional
  },
});
```

Photo data must be 1–10 MB of decoded bytes, base64-encoded. The photo's width and height must not exceed 10,000 px in total. The outbound `chatId` must be in the runtime's current allowlist.

## Chat info

Fetch metadata about a Telegram chat:

```ts
await mcpClient.callTool({
  name: 'getChatInfo',
  arguments: {
    chatId: '123456789',
  },
});
```

Returns the chat's `id`, `type`, and optionally `username`, `firstName`, `lastName`, or `title`. The `chatId` does not need to be in the runtime allowlist — this works for any chat the bot is a member of.

## Pending message history

Retrieve pending (unacknowledged) inbound messages with optional filters:

```ts
await mcpClient.callTool({
  name: 'getChatHistory',
  arguments: {
    chatId: '123456789', // optional filter
    senderId: '987654321', // optional filter
    kind: 'text',          // optional: 'text' | 'photo' | 'audio' | 'voice'
    limit: 100,            // optional, max 1,000
  },
});
```

> **Important:** The Telegram Bot API does not expose full server-side chat history. This tool returns only messages received by the bot since the current runtime started and not yet acknowledged. Acknowledged events are excluded. Restarting the proxy or destroying the runtime discards all pending messages.

## Bot profile management

Read and update the bot's display name, description, and short description:

```ts
// Get current profile
await mcpClient.callTool({ name: 'getMyProfile', arguments: {} });

// Set display name (0–64 chars)
await mcpClient.callTool({
  name: 'setMyName',
  arguments: { name: 'My Bot' },
});

// Set description shown in the chat with the bot (0–512 chars)
await mcpClient.callTool({
  name: 'setMyDescription',
  arguments: { description: 'A helpful assistant' },
});

// Set short description shown on the profile page (0–120 chars)
await mcpClient.callTool({
  name: 'setMyShortDescription',
  arguments: { shortDescription: 'Helpful assistant' },
});
```

### Profile photo limitation

The Telegram Bot API does **not** provide a method for a bot to update its own profile photo. The `setChatPhoto` method changes a group chat's photo (and requires admin rights), not the bot's own profile picture. Business-account photo methods (`setBusinessAccountProfilePhoto`) require a business connection and are not applicable to ordinary bots.

To change the bot's profile picture, use **@BotFather** on Telegram:

1. Open a chat with [@BotFather](https://t.me/BotFather)
2. Send `/setuserpic`
3. Select the bot
4. Upload the new profile photo

## Pending queue guarantees

Pending retrieval is bounded and oldest-first. Acknowledgements are idempotent, immediately hide matching events, and release complete media bodies. Lightweight event-ID tombstones continue suppressing duplicate Telegram updates while the runtime exists.

Pending decoded media is bounded per runtime. If accepting media would exceed that budget, the queue stores an omission notification instead of the base64 body. General text-event count backpressure is not provided.

These guarantees are runtime-scoped, not durable. Destroying a runtime or restarting the proxy discards its queue and deduplication tombstones. A later runtime may therefore receive an upstream Telegram update again.
