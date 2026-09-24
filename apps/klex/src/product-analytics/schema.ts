import { z } from 'zod';

export const USAGE_WINDOW_EVENT = 'klex_usage_window';
export const USAGE_WINDOW_SCHEMA_VERSION = 2;
export const AGENT_STARTED_EVENT = 'klex_agent_started';
export const AGENT_STARTED_SCHEMA_VERSION = 1;
export const ENROLLMENT_STARTED_EVENT = 'klex_enrollment_started';
export const ENROLLMENT_FINISHED_EVENT = 'klex_enrollment_finished';
export const ENROLLMENT_SCHEMA_VERSION = 1;

/**
 * Where an enrollment flow ran: the agent-picker wizard, the in-app Cloud
 * screen, or a token supplied via `--cloud-enroll-token` /
 * `KLEX_CLOUD_ENROLLMENT_TOKEN`.
 */
export const ENROLLMENT_METHODS = [
  'agent_picker',
  'cloud_screen',
  'token',
] as const;
export type EnrollmentMethod = (typeof ENROLLMENT_METHODS)[number];

/** Terminal state of one enrollment flow. */
export const ENROLLMENT_OUTCOMES = ['enrolled', 'failed', 'aborted'] as const;
export type EnrollmentOutcome = (typeof ENROLLMENT_OUTCOMES)[number];

/**
 * Where the process runs. Set by the launcher through `KLEX_DEPLOYMENT`;
 * unset means `self_hosted`, any unknown value collapses to `other`.
 */
export const DEPLOYMENTS = ['self_hosted', 'cloud', 'other'] as const;
export type Deployment = (typeof DEPLOYMENTS)[number];

const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Short, low-cardinality runtime token such as `darwin`, `arm64`, `24.1.0`. */
const token = z.string().regex(/^[\w.-]{1,32}$/);

/** Properties shared by every event. */
const baseShape = {
  $process_person_profile: z.literal(false),
  klex_version: z.string().min(1).max(64),
  deployment: z.enum(DEPLOYMENTS),
  telemetry_enabled_at_start: z.boolean(),
  cloud_enabled: z.boolean(),
  os_platform: token,
  os_arch: token,
  os_release: token,
  node_version: token,
};

/**
 * Closed property set of `klex_agent_started`. Sent once per process when an
 * agent directory was opened: headless with a valid `--data-dir`, or after
 * the user picked an agent. Strict: an unknown key fails validation.
 */
export const agentStartedPropertiesSchema = z.strictObject({
  ...baseShape,
  schema_version: z.literal(AGENT_STARTED_SCHEMA_VERSION),
});

export type AgentStartedProperties = z.infer<
  typeof agentStartedPropertiesSchema
>;

/**
 * Closed property set of `klex_usage_window`. Strict: an unknown key fails
 * validation, so a new field can only ship by changing this schema.
 */
export const usageWindowPropertiesSchema = z.strictObject({
  ...baseShape,
  schema_version: z.literal(USAGE_WINDOW_SCHEMA_VERSION),
  window_reason: z.enum(['interval', 'shutdown']),
  window_duration_s: count,
  cloud_enrolled: z.boolean().nullable(),
  mcp_connected_count: count.nullable(),
  sessions_active: count,
  sessions_started: count,
  sessions_ended: count,
  turns_total: count,
  steps_total: count,
  turns_per_session_max: count,
  steps_per_session_max: count,
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

/** Closed property set of `klex_enrollment_started`. */
export const enrollmentStartedPropertiesSchema = z.strictObject({
  ...baseShape,
  schema_version: z.literal(ENROLLMENT_SCHEMA_VERSION),
  enrollment_method: z.enum(ENROLLMENT_METHODS),
});

export type EnrollmentStartedProperties = z.infer<
  typeof enrollmentStartedPropertiesSchema
>;

/**
 * Closed property set of `klex_enrollment_finished`. Exactly one per started
 * flow, unless the process dies without a graceful shutdown.
 */
export const enrollmentFinishedPropertiesSchema = z.strictObject({
  ...baseShape,
  schema_version: z.literal(ENROLLMENT_SCHEMA_VERSION),
  enrollment_method: z.enum(ENROLLMENT_METHODS),
  enrollment_outcome: z.enum(ENROLLMENT_OUTCOMES),
  /** Rejected enrollment requests within the flow, including a final one. */
  failed_attempts: count,
  duration_s: count,
});

export type EnrollmentFinishedProperties = z.infer<
  typeof enrollmentFinishedPropertiesSchema
>;

export type AnalyticsEvent =
  | { event: typeof AGENT_STARTED_EVENT; properties: AgentStartedProperties }
  | { event: typeof USAGE_WINDOW_EVENT; properties: UsageWindowProperties }
  | {
      event: typeof ENROLLMENT_STARTED_EVENT;
      properties: EnrollmentStartedProperties;
    }
  | {
      event: typeof ENROLLMENT_FINISHED_EVENT;
      properties: EnrollmentFinishedProperties;
    };

/** Blank or unset means self-hosted; anything unrecognised is `other`. */
export function resolveDeployment(value: string | undefined): Deployment {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'self_hosted';
  return (DEPLOYMENTS as readonly string[]).includes(normalized)
    ? (normalized as Deployment)
    : 'other';
}
