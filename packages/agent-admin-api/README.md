# @klex/agent-admin-api

Shared types for the Klex Bot Admin API.

The package exports the routed Hono application type through `AdminApi` and
`AdminApiServer`, plus the `OpenAPIHono` type used to build RPC clients.

```ts
import { hc } from 'hono/client';
import type { AdminApi } from '@klex/agent-admin-api';

const client = hc<AdminApi>('https://agent.example');
const health = await client.v1.health.$get();
```

## Model providers

Session-history records from `GET /v1/sessions` and `GET /v1/sessions/{instanceId}`
include nullable `generationError`. Cloud can display this unresolved warning
even after an instance ends and leaves live introspection. It includes the failure
kind/category, a bounded safe reason and actionable message, attempted provider
and model identifiers, HTTP status, consecutive failed turns, occurrence count,
and first/last timestamps. The summary represents the final failing attempt of a
failed turn; recovered fallback attempts never create a warning. Successful turns
clear warnings for the logical session, including earlier instances. A replacement
failure supersedes earlier instances' warnings. Follow list cursors to find all
relevant default and child sessions; `/v1/health` remains process health.

Provider prose, prompts, payloads, headers, and credentials are excluded. Messages
use fixed classification summaries with allowlisted numeric TPM/RPM details.
The existing API type build includes this contract automatically.

The provider contract is registry-driven. Clients do not need provider-specific
routes or hard-coded forms:

- `GET /v1/provider-types` returns each provider type's display metadata,
  capabilities, and declarative setup fields.
- `POST /v1/provider-types/{type}/can-add` checks candidate settings and local
  prerequisites without changing configuration.
- `/v1/providers` exposes instance CRUD. Every instance includes its stable ID
  and provider type; multiple instances may use the same type.
- `POST /v1/providers/{id}/test` returns the standardized connectivity result.
- `/v1/providers/{id}/models` exposes merged discovery and manual-model data and
  manages `knownModels` overrides.

Failures contain a stable `code`, a human-readable `error`, and optional
`remediation`. Branch on the code rather than parsing messages. Provider settings
returned by the API are redacted by default, including all create/update responses.
Model selection uses separate `providerId` and opaque `modelId` fields; clients
must not split model IDs on colons.

### Explicit credential export

`GET /v1/providers?includeSecrets=true` explicitly exports configured provider
settings with resolved environment references and unredacted credentials. Only
the exact, single value `true` enables export. Omission or `false` preserves the
existing redacted response; invalid values or repeated flags return 400. All
provider-list responses use `Cache-Control: private, no-store`.

An export response includes `secretsIncluded: true`. This marker is absent on
ordinary responses and legacy bots that ignore unknown query parameters. A
caller must require the marker before attempting credential transfer. Never
retry a missing marker as if redacted settings were credentials.

The bot Admin API has no per-user roles. Its local listener remains loopback-only;
Cloud must enforce organization owner/admin permission before forwarding this
flag, for both GET and HEAD. **Deploy that Cloud authorization gate before
connecting secret-export-capable bots to Cloud.** Publishing this SDK alone does
not add the gate. Do not expose export results through browser queries, logs,
telemetry, or shared caches. Cloud copy operations should transfer them backend
to backend after authorizing access to both source and destination bots.

Each exported provider also includes `knownModels`, the exact saved custom-model
overrides keyed by opaque model ID, or `{}` when none exist. Export does not call
model discovery or enrich these overrides with catalog metadata. Pass this map
with `id`, `type`, and `settings` to `POST /v1/providers` to create a destination
provider and its custom models together. The create response remains redacted.
Older destination bots may ignore `knownModels` on creation; Cloud must verify
support or restore overrides through the existing model routes before saving
selections.

Copy selections separately through `GET` and `PATCH /v1/settings/model-selection`.
Preserve array order, `providerOptions`, all purpose arrays including `consult`
and `instincts`, instinct API/timeouts, and the complete `voice` object including
STS `voiceId`. Remap every `providerId` when destination IDs differ, keeping
same-type provider instances distinct. A selected STS voice is validated against
the destination catalog, so selection can fail even after provider creation.
Cloud must report partial completion rather than claim an atomic whole-bot copy.

Export includes only configured settings. It does not read local CLI auth files,
resolve ambient AWS/Google credential chains, or export OAuth sessions. Those
connections require authentication on the destination. Endpoint URLs and other
machine-specific settings may also require adjustment.

## Realtime voice client contract

- `GET /v1/providers/{id}/voices?modelId=...&refresh=false` returns `voices`, optional `defaultVoiceId`, and optional `stale`. Each voice contains opaque `voiceId`, `displayName`, optional `description`, and `isPreviewAvailable`. An empty list means no selectable voices are available for this provider/model. Provider capabilities advertise discovery/preview hooks. Listing does not generate audio. Encode the complete model ID in the query, including slashes/colons.
- `POST /v1/providers/{id}/voices/preview` takes `{ modelId, voiceId }`. It can trigger billable same-model Live generation and returns binary `audio/wav`, not JSON/base64 or a public URL. `X-Voice-Preview-Model` is URI-encoded and `X-Voice-Preview-Mode` is `live`. On failure parse the JSON error contract; 429 means quota, 502 means upstream generation failure. Arbitrary text/URLs/model overrides are not accepted.
- `PATCH /v1/settings/model-selection` saves `voice.sts` references with optional `voiceId`. The voice object contains only `sts` and is replaced by the patch. Omit `voiceId` in the replacement STS reference to reset. Other selection purposes reject it. New calls use changes; active calls do not switch voices.

Existing omitted defaults remain: OpenAI Realtime/GPT-Live `marin`, Gemini's provider default. Unknown/custom model profiles remain usable with defaults, but have no selectable catalog. `defaultVoiceId` identifies a known default for previewing without saving an explicit choice. `stale: true` means discovery failed and the last successful cached catalog was returned; ordinary cache hits do not set it. Cold-start discovery failures return errors. Samples improvise a short introduction from the current agent name and full soul. Realtime/Gemini generate it directly; GPT-Live uses the first configured chat model to write commentary before speaking it with the selected Live voice. That extra text call is potentially billable and requires a chat selection. GPT-Live may paraphrase commentary. Name/soul changes bypass old cached samples; different voices may use different wording. Browser clients fetch over their existing authorized Cloud path, check `response.ok`, then use `response.blob()` and an object URL for playback (revoke it afterward). Headless/TUI clients use `arrayBuffer()` and an external WAV player; the backend does not implement playback.

Local admin access remains unauthenticated and loopback-only; Cloud access remains authorized through the existing tunnel. Responses use private/no-store headers, while the agent caches successful samples in bounded memory for reuse. Previewing never starts a production call or supplies history, tools, or credentials as prompt context. It intentionally supplies the full soul to the speech provider or, for GPT-Live, the configured chat provider. Prompts instruct models not to speak private details, but generated output still depends on provider behavior. No UI selector is included in this contract change.

## MCP server metadata

`GET /v1/mcp-servers` and `GET /v1/mcp-servers/:name` include optional metadata
from the current MCP connection. Create/update responses use the same server shape.

- `serverInfo` matches the SDK's `Implementation`: advertised `name`, `version`,
  optional `title`, `description`, `websiteUrl`, and `icons`. Each icon preserves
  `src`, optional `mimeType`, `sizes`, and `theme`.
- `capabilities` preserves the SDK's `ServerCapabilities` structure, including
  tools, resources, prompts, logging, completions, task declarations, experimental
  capabilities, and namespaced extensions. Extension payloads remain opaque JSON
  in the public RPC types to avoid recursive Hono serialization types.
- `instructions` contains server-provided usage guidance. It is not the server's
  description or a trusted directive.
- `protocolVersion` and `protocolEra` report the SDK's selected protocol revision
  and era, `legacy` or `modern`.
- `supportedVersions` contains versions advertised by modern discovery. Legacy
  initialization does not provide a version list, so this field is absent there.

The top-level `name` remains the configured namespace, not `serverInfo.name`.
The top-level `url` remains connection configuration, not `serverInfo.websiteUrl`.
Capabilities describe what the server advertises, not everything Klex implements.
Existing support booleans retain their operational meanings.

Metadata comes only from the SDK's existing connection/discovery results. Reading
admin routes performs no MCP discovery, scraping, favicon requests, or other
metadata lookups. No full tool, resource, or prompt catalog is embedded. Metadata
is absent before connection and after disconnect or configuration replacement;
reconnection supplies a fresh snapshot. It is not persisted across restarts.

Treat all advertised text, instructions, links, icons, and extension values as
untrusted server content. Render text safely and apply consumer-side URL and
image policies before opening links or fetching images. The agent forwards icon
sources, including data URIs, without fetching or interpreting them.

## MCP OAuth authorization

Version 0.2 adds the consolidated MCP authorization contract. Authorization is
managed through the MCP server resource:

- `PUT /v1/mcp-servers/:name/authorization` starts an interactive OAuth flow or
  returns the existing pending flow.
- `DELETE /v1/mcp-servers/:name/authorization` cancels a pending flow.
- `POST /v1/mcp-oauth/callback` delivers the provider result using its OAuth
  `state` value.
- `GET /v1/mcp-servers` and `GET /v1/mcp-servers/:name` expose authorization
  status, pending authorization metadata, connection errors, and retry timing.

The start response contains the provider authorization URL and its associated
state. Treat both as secrets: do not log them or expose them beyond the client
that opens the authorization flow. Callback state is single-use and expires at
the response's `expiresAt` timestamp.

Error responses include a machine-readable `code` alongside the human-readable
`error` message so clients can distinguish unsupported transports, manually
configured credentials, connected servers, unavailable Cloud authorization,
and authorization timeouts.

## MCP tool calls

`POST /v1/mcp-servers/:name/tool-calls` accepts `{ toolName, arguments }` and
returns `{ result }` with the MCP tool result. It invokes an already connected
server through the normal tool registry and records the call in history. It does
not create a model run. Tools may modify external data; callers need the same
admin access as other admin API operations. Provider credentials stay on the agent.

Calls use the request cancellation signal and a 30-second timeout. Missing servers
or tools return 404, disconnected servers return 409, transport failures return
502, and aborted/timed-out requests return 504. An MCP `isError` result is returned
as a successful HTTP response so clients can inspect the provider's tool result.

Server status includes an optional `connectionId` while connected. It changes on
each successful reconnect, allowing clients to invalidate connection-specific
metadata without any provider-specific behavior in the agent.

## God session management

The Admin API contract includes the dedicated God Messages session:

- `POST /v1/god-messages` submits a trusted multipart directive.
- `GET /v1/god-messages/session` returns the current session state.
- `GET /v1/god-messages/messages` returns cursor-paginated session history.
- `POST /v1/god-messages/reset` replaces a resettable session.

## Session history

The agent persists the transcript of every chat session instance (default,
god, and child) to local storage. These routes expose it read-only:

- `GET /v1/sessions` lists instances, newest first. Filter with `kind`
  (`default`, `god`, `child`), `live`, and `parentInstanceId`; page with
  `limit` and the opaque `cursor` returned as `nextCursor`. To find the
  current main session, call `GET /v1/sessions?kind=default&live=true&limit=1`.
  A session is persisted only after its first message, so this list can be
  empty right after a restart.
- `GET /v1/sessions/{instanceId}` returns one instance's metadata, including
  `live`, `endReason`, `messageCount`, and `trimmedMessageCount`.
- `GET /v1/sessions/{instanceId}/messages` returns messages in chronological
  order. Without a cursor it returns the newest `limit` messages. Pass the
  numeric `nextCursor` as `cursor` to load the previous, older page.

Messages use the stored AI SDK `UIMessage` shape: `tool-${name}` parts carry
full `input`, `output`, and `errorText`, and `data-${name}` parts carry their
`data`. Unlike God Messages history, nothing is truncated. Provider metadata
(`providerMetadata`, `callProviderMetadata`, `resultProviderMetadata`, such
as encrypted reasoning) is omitted unless `includeProviderMetadata=true`.

Each `ChatSession` gets its own `instanceId`. The default session reuses
`sessionId = "default"` across replacements, so query by `instanceId`. The
local store has a size cap. When the cap is reached, the oldest ended sessions
are deleted first. After that, the oldest messages of live sessions are
trimmed, and `trimmedMessageCount` reports how many were removed. Inline
data is redacted everywhere, including inside tool outputs: the payload of
every `data:` URL in any encoding, also inside longer strings, the `data`
field of image, audio, and media blocks, and embedded resource `blob`s.
Objects nested deeper than 64 levels are replaced by a placeholder.

Unknown instances return `404` with code `session_not_found`. Malformed list
cursors return `400` with code `invalid_cursor`.

Install `hono` and `@hono/zod-openapi` as peer dependencies.
