import { z } from 'zod';

export const USAGE_WINDOW_EVENT = 'klex_usage_window';
export const USAGE_WINDOW_SCHEMA_VERSION = 1;

const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Short, low-cardinality runtime token such as `darwin`, `arm64`, `24.1.0`. */
const token = z.string().regex(/^[\w.-]{1,32}$/);

/**
 * Closed property set of `klex_usage_window`. Strict: an unknown key fails
 * validation, so a new field can only ship by changing this schema.
 */
export const usageWindowPropertiesSchema = z.strictObject({
  $process_person_profile: z.literal(false),
  schema_version: z.literal(USAGE_WINDOW_SCHEMA_VERSION),
  klex_version: z.string().min(1).max(64),
  window_reason: z.enum(['interval', 'shutdown']),
  window_duration_s: count,
  telemetry_enabled_at_start: z.boolean(),
  cloud_enabled: z.boolean(),
  cloud_enrolled: z.boolean().nullable(),
  mcp_connected_count: count.nullable(),
  sessions_active: count,
  sessions_started: count,
  sessions_ended: count,
  turns_total: count,
  steps_total: count,
  turns_per_session_max: count,
  steps_per_session_max: count,
  os_platform: token,
  os_arch: token,
  os_release: token,
  node_version: token,
  process_uptime_s: count,
  /** Window average, percent of one core. Can exceed 100. */
  cpu_avg_pct: z.number().nonnegative().max(100_000),
  /** RSS and JS heap at the moment the event is built. */
  memory_rss_mb: count,
  memory_heap_used_mb: count,
  /** Peak RSS since process start, not per window. */
  memory_rss_peak_mb: count,
});

export type UsageWindowProperties = z.infer<typeof usageWindowPropertiesSchema>;
