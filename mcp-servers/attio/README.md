# Attio records connector (KLEX-41)

Private, embeddable MCP server for a **customer-created Attio app**. This implementation is a reviewable integration foundation, **not production ready**. It contains no hosted database, KMS, customer management website, verified Cloud authenticator, or deployed callback. It does not alter generic MCP OAuth in `apps/klex`.

## Boundary and integration blockers

The host supplies `ConnectionStore`, `KeyWrapper`, and `Authenticator`, constructs `AttioService`, and mounts `createAttioHttp(service, authenticator).fetch`. The only HTTP resource implemented here is `POST /connections/{connectionId}/mcp`. Every request authenticates a Klex principal and checks tenant plus principal ownership. Attio tokens are never accepted from MCP callers. A connection ID alone does not grant access.

Management methods are a trusted server-side API, not public HTTP endpoints. A production host must separately authorize customer management, resolve the agent principal being managed, enforce CSRF protection and authenticated browser-session binding, and expose `create`, `start`, `callback`, `status`, `rotateAppSecret`, and `disconnect`. Do not copy tenant, principal, or browser-session IDs from submitted JSON. Do not let an agent's MCP access credential authorize management. Render status as escaped text. Return callback success/status only, remove callback query parameters from the browser location, send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and redact callback URLs, codes, secrets, state, request bodies, and authorization headers from access logs and traces. The configured callback URI is fixed; callback input has no redirect override.

No hosted integration is invented here. Before deployment, implement and test:

- A durable transactional database adapter with strongly consistent reads, atomic generation CAS and single-use state consumption across processes, unique tenant/connection keys, encrypted backups, attempt expiry cleanup, and forward-only service migrations.
- A real KMS key wrapper, least-privilege access policies, rotation and recovery procedures, and audit events containing only actor/connection/operation/outcome/correlation metadata.
- Verified Klex authentication, ownership resolution and the customer management/callback host described above, including network-level request timeouts, concurrency/rate limits, and body limits.
- Customer-app live acceptance: installation eligibility, returned grants, expiry/revocation propagation, app-secret rotation and search availability. Mock tests do not prove these provider behaviors.

`MemoryConnectionStore` and `LocalKeyWrapper` in `@klex/attio/dev` are deterministic local/test adapters in behavior (cryptographic keys, nonces and OAuth state remain random). They write no files. Restart loses all connections and pending attempts; there is no local snapshot/import format. Losing state fails closed. They are not a production database or KMS. Never put either store or key in an agent data directory.

Local-data classification: **no representation change**. No agent configuration, persisted JSON, SQLite schema, migration registry, or identity private key is changed. A future durable server adapter needs its own forward-only schema migrations; placing any structured state under an agent directory would additionally require registration in the agent's local-data registry.

## Customer setup contract

1. Create an Attio app for the intended workspace. Configure exactly the callback URI supplied by the embedding host and the app scopes `object_configuration:read` and `record_permission:read-write`. This connector requires that exact read-write grant; verify its returned representation during live acceptance.
2. Submit client ID and secret through the authenticated host management surface. `service.create(verifiedPrincipal, {clientId, clientSecret})` returns an opaque connection ID and status, never the secret. The secret submission is write-only.
3. Call `service.start(verifiedPrincipal, connectionId, verifiedBrowserSession)`. Redirect the customer to its `authorizationUrl`. Do not log or send that URL to the agent. Starting consent invalidates any existing token and authorization generation.
4. On the fixed callback route, pass only `state`, `code` or `error` to `service.callback`, with the same verified customer/agent binding and browser session. State is 32 random bytes, stored only as a hash, expires after ten minutes, and is atomically consumed before code exchange. Denial consumes state too; retry requires a new start.
5. The server exchanges the code and introspects the token. It requires an active Bearer token, matching client ID, required grants, unexpired or nullable expiry, and a valid workspace UUID. The first successful callback binds the workspace. Reconnect must use that same workspace; create a separate Klex connection for another workspace.
6. Configure Klex with the host's connection-specific MCP URL and Klex access credential, **never an Attio credential**. `status` reports the workspace, grants and connection status.

The production management surface is a blocker, so these steps are an integration contract rather than a claim that a hosted setup UI exists. For an isolated local harness, construct `MemoryConnectionStore`, supply a separate 32-byte local wrapping key, inject a mock HTTP fetcher or dedicated customer workspace, and use the service methods directly. `http://127.0.0.1/...` callbacks are allowed for local development; production callbacks require HTTPS. The package has no default listener or permissive default authenticator.

## Tools and exact semantics

All record requests use `https://api.attio.com`; redirects are disabled. Object slugs/IDs are single safe path segments and record IDs are UUIDs. Inputs cannot override URL, headers, method, workspace, connection, app or credentials.

| Tool | Request | Input |
| --- | --- | --- |
| `query_records` | `POST /v2/objects/{object}/records/query` | `object`, optional structured `filter`/`sorts`, `limit` 1–100 (default 25), `offset` 0–1,000,000 (default 0) |
| `search_records` | `POST /v2/objects/records/search` | `query` 1–256 characters, 1–20 `objects`, `limit` 1–25; server adds `request_as: {type: "workspace"}` |
| `get_record` | `GET /v2/objects/{object}/records/{record_id}` | `object`, `record_id` |
| `create_record` | `POST /v2/objects/{object}/records` | `object`, typed `values` |
| `update_record_append` | `PATCH /v2/objects/{object}/records/{record_id}` | `object`, `record_id`, typed `values` |
| `update_record_replace` | `PUT /v2/objects/{object}/records/{record_id}` | `object`, `record_id`, typed `values` |

Writes send exactly `{data:{values}}`. Create never upserts. PATCH preserves existing multiselects; Attio describes new values as **prepended**, so “append” does not promise tail order. PUT replaces only supplied attributes; `[]` clears a supplied attribute, and omitted attributes are preserved. Scalars retain Attio semantics. Typed attribute payloads pass through without flattening; Attio performs schema validation. This release does not fetch metadata or manage schemas. No verified conditional-write contract exists; concurrent replacements can lose intervening changes.

Examples:

```json
{"object":"companies","filter":{"domains":{"domain":{"$eq":"example.com"}}},"limit":10,"offset":0}
```

```json
{"query":"Ada Lovelace","objects":["people"],"limit":5}
```

```json
{"object":"people","values":{"email_addresses":[{"email_address":"ada@example.com"}]}}
```

For append/replace, supply the same `object` and `record_id`, with `values: {"your_multiselect":["New option"]}` or `values: {"your_multiselect":[]}` respectively. Use an existing attribute and valid option in the customer's schema.

Query returns `data` and pagination `{offset,limit,returned,nextOffset}`. A full page yields the next candidate offset, not a guarantee that more results exist or a snapshot across pages. Search returns summaries only, without fabricated pagination. Search is beta and eventually consistent; get/query verify writes. Unavailable search produces a capability error, with no hidden query fallback. Record identity workspace IDs are checked before releasing results. Input JSON is limited to 64 KiB and depth 16, incoming MCP bodies to 128 KiB, and upstream response bodies to 1 MiB. Oversized results fail rather than silently truncating values.

## Credentials, revocation and errors

Client secrets and tokens use separate AES-256-GCM envelopes with fresh 256-bit data keys and 96-bit nonces. Authenticated context binds format version, tenant, connection and purpose. Only ciphertext, tag, nonce, wrapped data key and key version enter the store. Wrapping keys remain outside the store. Decryption/key failures block operations with no plaintext fallback. Plaintext exists transiently in Node memory; JavaScript strings cannot be reliably zeroized. There is no token cache.

Every operation introspects before dispatch, then checks the persisted generation before each record request/retry and before returning results. Inactive/expired tokens, upstream 401, missing grants, client/workspace mismatch or foreign record identity disable the credential and require explicit reconnect. Introspection outages block the invocation without declaring revocation; ordinary record-level 403 does not prove revocation. Detection occurs on use because webhooks are deferred. Disconnect deletes the active local token and fences pending callbacks. It does not claim provider-side revocation. Already-dispatched writes cannot be recalled, even when their result is fenced. No refresh flow, automatic reinstall or automatic credential revival is implemented.

Errors contain only `{code,message,retryable,retryAfterMs?,outcome?,correlationId}`. No raw provider error body or exception text is exposed. Field-level provider messages are intentionally omitted because they can echo secrets or submitted values. Reads (including query/search POST) retry transient network/5xx/429 failures at most twice, with jitter, a 15-second budget and 5-second attempt timeout. Retry-After supports seconds and HTTP dates; advisory delays are capped at 60 seconds, and delays outside the remaining budget are returned without retry. Mutations and authorization-code exchanges are never automatically replayed. Ambiguous writes return `WRITE_OUTCOME_UNKNOWN`: verify via get/query before considering another write. Validation, permission, missing record and create-conflict errors do not retry.

## Operator runbook and acceptance

- Rotation: retain old KMS versions for decryption, switch the active wrapping version, re-encrypt envelopes through a reviewed, generation-fenced migration, verify decryptability, then retire old keys only after backup retention permits it. `rotateAppSecret` invalidates the token and pending consent and requires reconnect; it does not silently change client IDs.
- Recovery: a production adapter must restore ciphertext and connection/status/generation together. Never restore an older active credential over a later disconnect/revocation. Test CAS/state consumption with multiple processes and crash injection. Verify backup restoration and KMS availability before serving requests. The dev adapter cannot prove restart durability.
- Revocation: inspect sanitized status, fix app configuration/grants if needed, then explicitly reconnect the same workspace. Do not bypass introspection, decrypt failures or generation checks.
- Live acceptance: in a dedicated workspace, query a company by domain, search a person, get/create a record, append a multiselect option, replace/clear it, and exercise a custom object. Verify omitted attributes/scalars and PATCH/PUT effects with get/query. Test customer cancellation, token revocation, reinstall and secret rotation. No live credentials are included or required for mocked tests.

```sh
pnpm --filter @klex/attio test
pnpm --filter @klex/attio typecheck
pnpm format
pnpm format:check
pnpm check
```

Provider contracts checked against [OAuth introspection](https://docs.attio.com/docs/oauth/introspect) (bearer header), [token exchange](https://docs.attio.com/docs/oauth/token), [search](https://docs.attio.com/rest-api/endpoint-reference/records/search-records), [PATCH](https://docs.attio.com/rest-api/endpoint-reference/records/update-a-record-append-multiselect-values), and [PUT](https://docs.attio.com/rest-api/endpoint-reference/records/update-a-record-overwrite-multiselect-values). Mocked requests pin these contracts; provider behavior and customer eligibility remain live acceptance gates.

No delete, upsert, merge, lists, notes, tasks, messaging, webhooks, native `@KlexBot` claim or Slack-parity behavior is provided.
