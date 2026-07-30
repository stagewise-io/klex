import { parseArgs } from 'node:util';

import { createLogger } from '@stagewise/logger';

export interface CliOptions {
  dataDirectory: string;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', short: 'd' },
      help: { type: 'boolean', short: 'h' },
    },
    allowNegative: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const dataDirectory =
    values['data-dir'] ?? process.env.KLEX_DATA_DIR ?? process.cwd();

  return { dataDirectory };
}

function printHelp(): void {
  const logger = createLogger({ name: 'klex' });
  logger.info(
    `
Klex Agent v1.0.0

Usage: klex [options]

Options:
  -d, --data-dir <path>   Working directory for agent data (overrides KLEX_DATA_DIR)
  -h, --help              Show this help message
`,
  );
}
