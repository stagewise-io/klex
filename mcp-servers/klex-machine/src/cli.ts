import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  type RawRuntimeConfig,
  type RuntimeConfig,
  resolveRuntimeConfig,
} from './config.js';

export type MachineMode = 'local' | 'enrolled' | 'managed';

export type CliResult =
  | { action: 'help' }
  | { action: 'version' }
  | { action: 'enroll'; cloudBaseUrl: string; code: string; dataDir: string }
  | {
      action: 'serve';
      config: RuntimeConfig;
      dataDir: string;
      mode: MachineMode;
    };

export async function parseCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  processCwd: string = process.cwd(),
): Promise<CliResult> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'log-level': { type: 'string' },
      mode: { type: 'string' },
      'data-dir': { type: 'string' },
      'cloud-base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (parsed.values.help) return { action: 'help' };
  if (parsed.values.version) return { action: 'version' };

  const dataDir = resolve(
    parsed.values['data-dir'] ??
      env.KLEX_MACHINE_DATA_DIR ??
      resolve(homedir(), '.klex-machine'),
  );
  const [command, subcommand, value, ...extra] = parsed.positionals;
  if (
    command === 'cloud' &&
    subcommand === 'enroll' &&
    value &&
    !extra.length
  ) {
    return {
      action: 'enroll',
      cloudBaseUrl:
        parsed.values['cloud-base-url'] ??
        env.KLEX_MACHINE_CLOUD_BASE_URL ??
        'https://cloud.stagewise.io',
      code: value,
      dataDir,
    };
  }
  if (command !== 'serve' || subcommand || value || extra.length > 0) {
    throw new Error(
      'Expected command: klex-machine serve or klex-machine cloud enroll <code>',
    );
  }
  const mode = parsed.values.mode ?? env.KLEX_MACHINE_MODE ?? 'local';
  if (mode !== 'local' && mode !== 'enrolled' && mode !== 'managed') {
    throw new Error('Invalid mode. Expected local, enrolled, or managed.');
  }

  const raw: RawRuntimeConfig = {
    cwd: parsed.values.cwd ?? env.KLEX_MACHINE_CWD,
    host: parsed.values.host ?? env.KLEX_MACHINE_HOST,
    port: parsed.values.port ?? env.KLEX_MACHINE_PORT,
    logLevel: parsed.values['log-level'] ?? env.KLEX_MACHINE_LOG_LEVEL,
  };
  return {
    action: 'serve',
    config: await resolveRuntimeConfig(raw, processCwd),
    dataDir,
    mode,
  };
}

export function packageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  if (typeof packageJson.version !== 'string') {
    throw new Error('Package version is missing');
  }
  return packageJson.version;
}

export function helpText(): string {
  return `klex-machine ${packageVersion()}

Usage:
  klex-machine serve [options]
  klex-machine cloud enroll <code> [options]

Options:
  --cwd <path>        Default working directory
  --host <address>    Listener address (default: 127.0.0.1)
  --port <number>     Listener port (default: 3123)
  --log-level <level> trace, debug, info, warn, error, or fatal
  --mode <mode>       local, enrolled, or managed (default: local)
  --data-dir <path>   Identity directory (default: ~/.klex-machine)
  --cloud-base-url    Cloud API URL used for enrollment
  -h, --help          Show help
  -v, --version       Show version

Environment:
  KLEX_MACHINE_CWD
  KLEX_MACHINE_HOST
  KLEX_MACHINE_PORT
  KLEX_MACHINE_LOG_LEVEL
  KLEX_MACHINE_MODE
  KLEX_MACHINE_DATA_DIR
  KLEX_MACHINE_CLOUD_BASE_URL`;
}
