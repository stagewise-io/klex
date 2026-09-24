import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { createLogger } from '@stagewise/logger';

import { type Deployment, resolveDeployment } from '@/product-analytics';
import { KLEX_VERSION } from '@/release';
import {
  resolveTelemetryEndpoint,
  resolveTelemetryMode,
  TELEMETRY_DEBUG_ENV,
  TELEMETRY_DISABLE_ENV,
  TELEMETRY_ENDPOINT_ENV,
  type TelemetryMode,
} from '@/telemetry-config';

export interface CliOptions {
  /** Explicit agent directory, or undefined in interactive discovery mode. */
  dataDirectory: string | undefined;
  /** Root containing discoverable agent directories. */
  agentRoot: string;
  cloudEnabled: boolean;
  cloudBaseUrl: string;
  /** OTLP base URL. Undefined means telemetry is off. */
  telemetryEndpoint: string | undefined;
  /** Effective process-wide telemetry level. Never read from config. */
  telemetryLevel: TelemetryMode;
  /**
   * Aggregate-only product analytics. On by default; CLI/env only, never
   * configurable from the UI or config.json.
   */
  analyticsEnabled: boolean;
  /**
   * Deployment label reported in analytics. Resolved here so the reported
   * value is always the one the CLI/env precedence produced.
   */
  deployment: Deployment;
  cloudEnrollToken: string | undefined;
  headless: boolean;
  dangerousLocalAdminApiPort: number | undefined;
  allowDangerousUnsecureCloud: boolean;
  verbose: boolean;
  /**
   * Diagnostic: load every native dependency and exit. Used by the packaged
   * executable smoke test. Deliberately undocumented in --help.
   */
  verifyNative: boolean;
}

/**
 * Blank is not a path. An empty or whitespace-only value would otherwise pass
 * `??` and turn an absolute default into a cwd-relative one, which is exactly
 * the per-directory agent split this resolution exists to prevent.
 */
function pathOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function portOrUndefined(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid local Admin API port: ${value}`);
  }

  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid local Admin API port: ${value}`);
  }
  return port;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', short: 'd' },
      help: { type: 'boolean', short: 'h' },
      headless: { type: 'boolean', short: 'H' },
      'cloud-base-url': { type: 'string' },
      'telemetry-endpoint': { type: 'string' },
      // Deprecated no-op: the telemetry identity is now per process. Still
      // accepted so existing launch scripts keep working.
      'reset-telemetry-identity': { type: 'boolean' },
      'telemetry-debug': { type: 'boolean' },
      'disable-telemetry': { type: 'boolean' },
      analytics: { type: 'boolean' },
      deployment: { type: 'string' },
      cloud: { type: 'boolean' },
      'cloud-enroll-token': { type: 'string' },
      'dangerous-local-admin-api-port': { type: 'string' },
      'allow-dangerous-unsecure-cloud': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      version: { type: 'boolean' },
      // Diagnostic flag, intentionally absent from printHelp().
      'verify-native': { type: 'boolean' },
    },
    allowNegative: true,
  });

  // Bare, parseable output on stdout. Deliberately not routed through the
  // logger: printHelp() uses a logger and therefore prefixes a timestamp and
  // level, which the installer cannot parse.
  if (values.version) {
    process.stdout.write(`${KLEX_VERSION}\n`);
    process.exit(0);
  }

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  // The root is deterministic and CWD-independent. Interactive mode uses it
  // for first-level agent discovery; an explicit data directory bypasses it.
  const agentRoot = join(
    pathOrUndefined(process.env.KLEX_HOME) ?? join(homedir(), '.klex'),
    'agents',
  );
  const dataDirectory =
    pathOrUndefined(values['data-dir']) ??
    pathOrUndefined(process.env.KLEX_DATA_DIR);

  // CLI args take priority over env vars. --no-cloud sets values.cloud to false.
  const cloudEnabled =
    values.cloud !== undefined
      ? values.cloud
      : process.env.KLEX_NO_CLOUD !== '1';

  const cloudBaseUrl =
    values['cloud-base-url'] ??
    process.env.KLEX_CLOUD_BASE_URL ??
    'https://cloud.klex.bot';

  // Telemetry is opt-in: no default endpoint, and nothing is read from config.
  const telemetryDisabled =
    values['disable-telemetry'] ?? process.env[TELEMETRY_DISABLE_ENV] === '1';
  const telemetryDebug =
    values['telemetry-debug'] ?? process.env[TELEMETRY_DEBUG_ENV] === '1';
  const endpoint = resolveTelemetryEndpoint(
    values['telemetry-endpoint'] ?? process.env[TELEMETRY_ENDPOINT_ENV],
  );
  const telemetryLevel = resolveTelemetryMode({
    endpoint,
    debug: telemetryDebug,
    disabled: telemetryDisabled,
  });
  const telemetryEndpoint = telemetryLevel === 'no' ? undefined : endpoint;

  // CLI wins over env. --no-analytics sets values.analytics to false.
  const analyticsEnabled =
    values.analytics !== undefined
      ? values.analytics
      : process.env.KLEX_NO_ANALYTICS !== '1' &&
        process.env.DO_NOT_TRACK !== '1';

  // CLI wins over env, even when blank (blank resolves to self_hosted).
  const deployment = resolveDeployment(
    values.deployment ?? process.env.KLEX_DEPLOYMENT,
  );

  const cloudEnrollToken =
    values['cloud-enroll-token'] ?? process.env.KLEX_CLOUD_ENROLLMENT_TOKEN;

  // CLI wins over env. --no-headless sets values.headless to false.
  const headless = values.headless ?? process.env.KLEX_HEADLESS === '1';

  const dangerousLocalAdminApiPort = portOrUndefined(
    values['dangerous-local-admin-api-port'] ??
      process.env.KLEX_DANGEROUS_LOCAL_ADMIN_API_PORT,
  );

  const allowDangerousUnsecureCloud =
    values['allow-dangerous-unsecure-cloud'] !== undefined
      ? values['allow-dangerous-unsecure-cloud']
      : process.env.KLEX_ALLOW_UNSECURE_CLOUD === '1';

  const verbose = values.verbose ?? false;

  const verifyNative = values['verify-native'] ?? false;

  return {
    dataDirectory,
    agentRoot,
    cloudEnabled,
    cloudBaseUrl,
    telemetryEndpoint,
    telemetryLevel,
    analyticsEnabled,
    deployment,
    cloudEnrollToken,
    headless,
    dangerousLocalAdminApiPort,
    allowDangerousUnsecureCloud,
    verbose,
    verifyNative,
  };
}

function printHelp(): void {
  const logger = createLogger({ name: 'klex', verbose: true });
  logger.info(
    `
Klex Bot v${KLEX_VERSION}

Usage: klex [options]

Options:
  -d, --data-dir <path>        Directory for agent data (overrides KLEX_DATA_DIR; interactive mode otherwise discovers agents under KLEX_HOME)
  -H, --headless               Run without the interactive CLI UI (overrides KLEX_HEADLESS)
  --no-headless                Run with the interactive CLI UI (overrides KLEX_HEADLESS)
  -h, --help                   Show this help message
  --version                    Print the version and exit
  --cloud-base-url <url>       Klex Cloud API base URL (overrides KLEX_CLOUD_BASE_URL, default: https://cloud.klex.bot)
  --telemetry-endpoint <url>   Enable telemetry and export to this OTLP base URL (overrides KLEX_TELEMETRY_ENDPOINT; telemetry is off without it)
  --telemetry-debug            Also export chat content and PII for this process; requires an endpoint (overrides KLEX_TELEMETRY_DEBUG)
  --disable-telemetry          Force telemetry off even if an endpoint is set (overrides KLEX_DISABLE_TELEMETRY)
  --no-analytics               Disable anonymous aggregate usage analytics (overrides KLEX_NO_ANALYTICS and DO_NOT_TRACK)
  --analytics                  Enable analytics even if KLEX_NO_ANALYTICS or DO_NOT_TRACK is set
  --deployment <name>          Deployment label for analytics: self_hosted or cloud (overrides KLEX_DEPLOYMENT)
  --no-cloud                   Disable Klex Cloud connectivity (overrides KLEX_NO_CLOUD)
  --cloud                      Enable Klex Cloud connectivity (overrides KLEX_NO_CLOUD)
  --cloud-enroll-token <code>  Enrollment token for headless enrollment (overrides KLEX_CLOUD_ENROLLMENT_TOKEN)
  --dangerous-local-admin-api-port <port>  Expose the unauthenticated Admin API on 127.0.0.1 (overrides KLEX_DANGEROUS_LOCAL_ADMIN_API_PORT)
  --allow-dangerous-unsecure-cloud  Allow http cloud base URL and ws tunnel (overrides KLEX_ALLOW_UNSECURE_CLOUD, default: false)
  -v, --verbose                   Enable verbose (pretty) logging (default: compact)

Environment:
  KLEX_HOME                    Root directory for all Klex data (default: ~/.klex)
  KLEX_TELEMETRY_ENDPOINT      Enable telemetry and export to this OTLP base URL
  KLEX_TELEMETRY_HEADERS       JSON object of extra OTLP request headers
  KLEX_TELEMETRY_DEBUG         Enable debug telemetry (chat content and PII) when set to 1; requires an endpoint
  KLEX_DISABLE_TELEMETRY       Force telemetry off when set to 1
  KLEX_NO_ANALYTICS            Disable anonymous usage analytics when set to 1. Analytics send one
                               start event, cloud enrollment outcomes, then aggregate counts every
                               2 h (sessions, turns, steps), OS and architecture, Node version, and
                               process CPU and memory; no prompts, content, names, paths or
                               persistent IDs
  DO_NOT_TRACK                 Same as KLEX_NO_ANALYTICS when set to 1
  KLEX_DEPLOYMENT              Deployment label reported in analytics: self_hosted (default) or cloud;
                               set by hosting launchers, other values are reported as other
  KLEX_SHUTDOWN_TIMEOUT_MS      Maximum graceful shutdown time in milliseconds (default: 15000)
`,
  );
}
