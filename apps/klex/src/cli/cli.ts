import { parseArgs } from 'node:util';

import { createLogger } from '@stagewise/logger';

export interface CliOptions {
  dataDirectory: string;
  cloudEnabled: boolean;
  cloudBaseUrl: string;
  cloudEnrollToken: string | undefined;
  adminPort: number;
  allowDangerousUnsecureCloud: boolean;
  verbose: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', short: 'd' },
      help: { type: 'boolean', short: 'h' },
      'cloud-base-url': { type: 'string' },
      cloud: { type: 'boolean' },
      'cloud-enroll-token': { type: 'string' },
      'admin-port': { type: 'string' },
      'allow-dangerous-unsecure-cloud': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
    },
    allowNegative: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const dataDirectory =
    values['data-dir'] ?? process.env.KLEX_DATA_DIR ?? process.cwd();

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

  return {
    dataDirectory,
    cloudEnabled,
    cloudBaseUrl,
    cloudEnrollToken,
    adminPort,
    allowDangerousUnsecureCloud,
    verbose,
  };
}

function printHelp(): void {
  const logger = createLogger({ name: 'klex', verbose: true });
  logger.info(
    `
Klex Agent v1.0.0

Usage: klex [options]

Options:
  -d, --data-dir <path>        Working directory for agent data (overrides KLEX_DATA_DIR)
  -h, --help                   Show this help message
  --cloud-base-url <url>       Klex Cloud API base URL (overrides KLEX_CLOUD_BASE_URL, default: https://cloud.klex.bot)
  --no-cloud                   Disable Klex Cloud connectivity (overrides KLEX_NO_CLOUD)
  --cloud                      Enable Klex Cloud connectivity (overrides KLEX_NO_CLOUD)
  --cloud-enroll-token <code>  Enrollment token for headless enrollment (overrides KLEX_CLOUD_ENROLLMENT_TOKEN)
  --admin-port <port>          Admin API port (overrides KLEX_ADMIN_PORT, default: 2706)
  --allow-dangerous-unsecure-cloud  Allow http cloud base URL and ws tunnel (overrides KLEX_ALLOW_UNSECURE_CLOUD, default: false)
  -v, --verbose                   Enable verbose (pretty) logging (default: compact)
`,
  );
}
