import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { createLogger } from '@stagewise/logger';

import { KLEX_VERSION } from '@/release';

export interface CliOptions {
  dataDirectory: string;
  cloudEnabled: boolean;
  cloudBaseUrl: string;
  cloudEnrollToken: string | undefined;
  headless: boolean;
  adminPort: number;
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

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', short: 'd' },
      help: { type: 'boolean', short: 'h' },
      headless: { type: 'boolean', short: 'H' },
      'cloud-base-url': { type: 'string' },
      cloud: { type: 'boolean' },
      'cloud-enroll-token': { type: 'string' },
      'admin-port': { type: 'string' },
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

  // Deterministic, CWD-independent. A PATH-installed klex must resolve the same
  // agent no matter which directory it is invoked from; a cwd-relative default
  // silently creates a separate agent (config, credentials, enrollment, logs)
  // per directory. Nested under agents/ so a future multi-agent picker can
  // enumerate $KLEX_HOME/agents/* without a migration.
  // Blank values are treated as unset throughout, so a stray `KLEX_HOME=` in a
  // shell profile or unit file cannot silently relocate the agent to the
  // current working directory.
  const klexHome =
    pathOrUndefined(process.env.KLEX_HOME) ?? join(homedir(), '.klex');
  const dataDirectory =
    pathOrUndefined(values['data-dir']) ??
    pathOrUndefined(process.env.KLEX_DATA_DIR) ??
    join(klexHome, 'agents', 'default');

  // CLI args take priority over env vars. --no-cloud sets values.cloud to false.
  const cloudEnabled =
    values.cloud !== undefined
      ? values.cloud
      : process.env.KLEX_NO_CLOUD !== '1';

  const cloudBaseUrl =
    values['cloud-base-url'] ??
    process.env.KLEX_CLOUD_BASE_URL ??
    'https://cloud.klex.bot';

  const cloudEnrollToken =
    values['cloud-enroll-token'] ?? process.env.KLEX_CLOUD_ENROLLMENT_TOKEN;

  const headless =
    values.headless === true || process.env.KLEX_HEADLESS === '1';

  const adminPort =
    values['admin-port'] !== undefined
      ? Number.parseInt(values['admin-port'], 10)
      : process.env.KLEX_ADMIN_PORT !== undefined
        ? Number.parseInt(process.env.KLEX_ADMIN_PORT, 10)
        : 2706;

  const allowDangerousUnsecureCloud =
    values['allow-dangerous-unsecure-cloud'] !== undefined
      ? values['allow-dangerous-unsecure-cloud']
      : process.env.KLEX_ALLOW_UNSECURE_CLOUD === '1';

  const verbose = values.verbose ?? false;

  const verifyNative = values['verify-native'] ?? false;

  return {
    dataDirectory,
    cloudEnabled,
    cloudBaseUrl,
    cloudEnrollToken,
    headless,
    adminPort,
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
  -d, --data-dir <path>        Directory for agent data (overrides KLEX_DATA_DIR and KLEX_HOME, default: $KLEX_HOME/agents/default)
  -H, --headless               Run without the interactive CLI UI (overrides KLEX_HEADLESS)
  -h, --help                   Show this help message
  --version                    Print the version and exit
  --cloud-base-url <url>       Klex Cloud API base URL (overrides KLEX_CLOUD_BASE_URL, default: https://cloud.klex.bot)
  --no-cloud                   Disable Klex Cloud connectivity (overrides KLEX_NO_CLOUD)
  --cloud                      Enable Klex Cloud connectivity (overrides KLEX_NO_CLOUD)
  --cloud-enroll-token <code>  Enrollment token for headless enrollment (overrides KLEX_CLOUD_ENROLLMENT_TOKEN)
  --admin-port <port>          Admin API port (overrides KLEX_ADMIN_PORT, default: 2706)
  --allow-dangerous-unsecure-cloud  Allow http cloud base URL and ws tunnel (overrides KLEX_ALLOW_UNSECURE_CLOUD, default: false)
  -v, --verbose                   Enable verbose (pretty) logging (default: compact)

Environment:
  KLEX_HOME                    Root directory for all Klex data (default: ~/.klex)
`,
  );
}
