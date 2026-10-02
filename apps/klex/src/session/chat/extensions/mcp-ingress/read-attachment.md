# readAttachment

`readAttachment` is a connector-independent tool registered by MCP ingress,
alongside `openResource`. Only sessions with MCP access can load this extension.
It does not use connector tokens, delegate credentials, or special-case a channel.

```json
{
  "url": "https://attachments.example/photo.png?signature=...",
  "filename": "photo.png",
  "mimeType": "image/png",
  "size": 12345
}
```

`url` is required (maximum 8,192 characters). Optional `filename` (255 characters)
is a hint only and is never a filesystem path. Optional `mimeType` (100 characters)
must agree with the sniffed format when specific. Missing or generic
`application/octet-stream` MIME hints and response headers defer to byte sniffing;
optional `size` is a nonnegative integer hint,
not a replacement for measuring the response. Unknown fields are rejected.

## Supported content

Static PNG, JPEG and WebP are sniffed, fully decoded with the existing Sharp
dependency, stripped of metadata and re-encoded as PNG. The selected configured
model must declare image input supporting PNG. Images are resized to at most
2,048 × 2,048 and the selected model's declared dimension/pixel limits. Its byte
limit also applies. A model fallback rechecks compatibility before projecting
media through the existing AI SDK provider content abstraction.
Realtime leases return `unsupported-provider`: their JSON tool-reply transport
cannot deliver ephemeral attachment images, even when the model accepts images.

PDFs return `unsupported-media`, including for providers whose upstream API may
accept PDFs: Klex's current capability schema has only image/audio inputs and no
bounded PDF renderer. Audio, animation, video, SVG, office documents and other
types are also unsupported by this tool. There is no page/frame option, OCR,
PDF conversion, or video processing. Existing text-only flows are unchanged.

## Authorization and network boundary

The exact URL must occur in a structured `resource_link` in this session's MCP
context, from a source whose MCP server is currently connected. Text mentioning a
URL, assistant-generated URLs, disconnected sources, and child/god sessions do
not grant access. A source must emit an attachment resource link before it can be
read. Compaction that removes that link requires the source to supply it again.
This is provenance-based authorization to an already-issued public capability
URL, not an authorization bypass for authenticated connector endpoints.

Only HTTPS on port 443 is allowed, without userinfo or fragments. All DNS answers
must be public addresses; loopback, private, link-local, multicast, reserved,
documentation and transition/translation ranges are rejected. The connection
uses a checked, pinned IP while TLS verifies the original hostname, preventing a
second DNS resolution from rebinding the destination. No connection pooling,
proxy configuration, ambient credentials, cookies or redirect following is used.
Non-200 responses and compressed transfer encodings are rejected.

## Limits and results

- 4 MiB maximum response, checked against both Content-Length and streamed bytes.
- 10-second total read/decode deadline, including DNS; cancellation reaches the
  HTTPS request. A timed-out operation cannot publish a late image.
- One active read per session; timeout or cancellation releases the slot even
  if underlying work ignores cancellation. Late work cannot publish media or
  release a newer read's slot. Image decoding allows at most 16,777,216 input pixels, one frame and
  a five-second Sharp processing timeout.
- At most four decoded images, each at most 4 MiB, retained in process memory.
  Handles expire after five minutes and are cleared when the extension closes.
  Expired/evicted images become explicit unavailable results.

Successful tool JSON contains only `{ "ok": true, "mimeType": "image/png",
"size": 12345 }`. On model-context projection its tool result includes ephemeral
multimodal image content. Bytes never enter canonical tool results, persistent
files, episodic memory or telemetry. Signed URLs are redacted from tool logging,
debug message telemetry and episodic memory. URLs remain in live session context
for authorization and model tool invocation. The configured inference provider
receives the image, as it does for other supported native media inputs.

Failures are nonthrowing `{ "ok": false, "error": { "code": "...",
"message": "Attachment unavailable: ..." } }` results. Codes include
`invalid-input`, `unauthorized`, `ssrf-rejected`, `fetch-failed`, `too-large`,
`timeout`, `unsupported-media`, `unsupported-provider`, `conversion-failed`, and
`provider-error`. No URL, response body, decoder exception or upstream error text
is returned. An explicit provider image-input rejection before tool side effects replaces attachment media
with `provider-error` and retries once without it; failures unrelated to media
continue through the existing generation error handling. No live provider calls
are required by the focused test suite.
