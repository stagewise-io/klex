# Testing Model Call Usage Logging

This document describes how to reliably test the usage logging feature — both the unit tests already in the repo and manual end-to-end verification.

## Running the existing test suites

Two test files cover the feature:

```bash
# From apps/klex/
npx vitest run src/model-call-logger/model-call-logger.test.ts src/admin-api/routes/v1/usage.test.ts
```

- **`model-call-logger.test.ts`** (16 tests) — tests the logger lifecycle, batched writes, flush behavior, retention cleanup, and `queryUsage` across all four granularities (`event`, `hourly`, `daily`, `weekly`) and all four split dimensions (`none`, `model`, `provider`, `endpoint`).

- **`usage.test.ts`** (21 tests) — tests the admin API route, including query param validation, passthrough to the logger, default values, error handling (400/500), and response shape.

## Test architecture

### Logger tests

Each test creates a throwaway SQLite database in a temp directory via `mkdtemp`. The `createLoggerModule()` helper:

1. Creates a temp dir under `/tmp/klex-modelcall-*`.
2. Instantiates `ModelCallLogger` with that path.
3. Calls `start()` (runs migrations + retention cleanup).
4. Returns `{ directory, module }`.

Tests use `makeRecord()` to build `ModelCallRecord` fixtures with sensible defaults, call `module.recordCall()` to queue records, then `module.flush()` to force-write them (bypassing the 5-second timer). Queries go through `module.queryUsage()`.

Key patterns:
- **Batched write verification**: Insert N records, flush, query with `granularity='event'`, assert `callCount === N`.
- **Aggregation verification**: Insert records across different timestamps, query with `granularity='daily'|'weekly'|'hourly'`, assert bucket keys and summed token counts.
- **Split verification**: Insert records with different `providerId`/`modelId`/`endpointId`, query with `splitBy='provider'|'model'|'endpoint'`, assert `splitKey` values match.
- **Retention**: Insert a record with a `finishedAt` >365 days ago, restart the logger, assert the record was deleted.

### Admin API tests

Uses Hono's `app.request()` in-memory test pattern — no HTTP server needed. The `setupTestApp` helper from `./test-utils` creates an `OpenAPIHono` instance with the validation hook configured. Each test:

1. Creates a mock `ModelCallLogger` with `vi.fn()` for `queryUsage`.
2. Mounts the route via `app.openapi(getUsageRoute, getUsage(deps))`.
3. Calls `app.request('/v1/usage?...')` and asserts on the response.

This tests the full middleware stack (Zod validation, route handler, error handling) without touching the database.

## Manual end-to-end testing

### 1. Start klex and generate traffic

Start the application with an explicit local Admin API port. Every model call (chat, extension-initiated) will be logged to `{dataDir}/model-calls.sqlite`.

```bash
klex --dangerous-local-admin-api-port 2706
```

### 2. Query the admin API

The Admin API is private by default. The dangerous option above exposes its unauthenticated routes on loopback for manual testing. Query the usage endpoint:

```bash
# Default: daily granularity, no split, last 1000 records
curl http://127.0.0.1:2706/v1/usage

# Split by model, daily buckets, specific time range
curl 'http://127.0.0.1:2706/v1/usage?splitBy=model&granularity=daily&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z'

# Per-event (no aggregation), limit to 50
curl 'http://127.0.0.1:2706/v1/usage?granularity=event&limit=50'

# Weekly buckets split by provider
curl 'http://127.0.0.1:2706/v1/usage?granularity=weekly&splitBy=provider'
```

### 3. Inspect the database directly

```bash
# Check row count
sqlite3 <dataDir>/model-calls.sqlite 'SELECT COUNT(*) FROM model_calls;'

# See recent calls
sqlite3 <dataDir>/model-calls.sqlite \
  'SELECT id, provider_id, model_id, input_tokens, output_tokens, started_at FROM model_calls ORDER BY started_at DESC LIMIT 10;'

# Manual aggregation by model
sqlite3 <dataDir>/model-calls.sqlite \
  "SELECT model_id, COUNT(*), SUM(input_tokens), SUM(output_tokens) FROM model_calls GROUP BY model_id;"

# Verify retention cleanup ran (check log output for "Model call retention cleanup completed")
sqlite3 <dataDir>/model-calls.sqlite \
  "SELECT MIN(finished_at), MAX(finished_at) FROM model_calls;"
```

### 4. Verify WAL mode is active

```bash
sqlite3 <dataDir>/model-calls.sqlite 'PRAGMA journal_mode;'
# Should return: wal
```

## API query parameter reference

| Parameter     | Type    | Default   | Description                                      |
|---------------|---------|-----------|--------------------------------------------------|
| `splitBy`     | enum    | `none`    | `none`, `model`, `provider`, `endpoint`          |
| `granularity` | enum    | `daily`   | `event`, `hourly`, `daily`, `weekly`             |
| `from`        | string  | (none)    | ISO 8601 datetime — inclusive lower bound        |
| `to`          | string  | (none)    | ISO 8601 datetime — exclusive upper bound        |
| `limit`       | integer | `1000`    | 1–10000, max rows returned (event granularity)   |

## Response shape

```json
{
  "dataPoints": [
    {
      "bucket": "2026-08-14",
      "splitKey": "gpt-4o",
      "callCount": 5,
      "inputTokens": 1250,
      "outputTokens": 800,
      "inputCacheWriteTokens": 0,
      "inputCacheReadTokens": 0,
      "ttftMs": 234.5,
      "totalDurationMs": 1200.0,
      "errorCount": 0
    }
  ]
}
```

- `bucket` is `null` when `granularity=event`.
- `splitKey` is `null` when `splitBy=none`.
- `ttftMs` and `totalDurationMs` are averages (null if no records had values).
