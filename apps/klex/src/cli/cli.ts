import { parseArgs } from 'node:util';

import { createLogger } from '@stagewise/logger';

export interface CliOptions {
  dataDirectory: string;
  cloudEnabled: boolean;
  cloudBaseUrl: string;
  cloudEnrollToken: string | undefined;
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

  return { dataDirectory, cloudEnabled, cloudBaseUrl, cloudEnrollToken };
}

function printHelp(): void {
  const logger = createLogger({ name: 'klex' });
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
`,
  );
}
