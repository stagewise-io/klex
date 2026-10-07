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
  | {
      action: 'enroll';
      cloudBaseUrl: string;
      code: string;
      config: RuntimeConfig;
      dataDir: string;
      serve: true;
      omitHostDetails: boolean;
    }
  | {
      action: 'enroll';
      cloudBaseUrl: string;
      code: string;
      dataDir: string;
      serve: false;
    }
  | {
      action: 'managed-bootstrap';
      cloudBaseUrl: string;
      config: RuntimeConfig;
      dataDir: string;
      enrollmentCodeFile: string;
      omitHostDetails: boolean;
    }
  | {
      action: 'serve';
      config: RuntimeConfig;
      dataDir: string;
      mode: MachineMode;
      omitHostDetails: boolean;
    };

export async function parseCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  processCwd: string = process.cwd(),
): Promise<CliResult> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      cwd: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'log-level': { type: 'string' },
      mode: { type: 'string' },
      'data-dir': { type: 'string' },
      'cloud-base-url': { type: 'string' },
      'enrollment-code-file': { type: 'string' },
      serve: { type: 'boolean' },
      'omit-host-details': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (parsed.values.help) return { action: 'help' };
  if (parsed.values.version) return { action: 'version' };

  const omitHostDetails =
    parsed.values['omit-host-details'] ??
    omitHostDetailsFromEnv(env.KLEX_MACHINE_OMIT_HOST_DETAILS);
  const dataDir = resolve(
    parsed.values['data-dir'] ??
      env.KLEX_MACHINE_DATA_DIR ??
      resolve(homedir(), '.klex-machine'),
  );
  const [command, subcommand, value, ...extra] = parsed.positionals;
  const cloudBaseUrl =
    parsed.values['cloud-base-url'] ??
    env.KLEX_MACHINE_CLOUD_BASE_URL ??
    'https://cloud.klex.bot';
  const raw: RawRuntimeConfig = {
    cwd: parsed.values.cwd ?? env.KLEX_MACHINE_CWD,
    host: parsed.values.host ?? env.KLEX_MACHINE_HOST,
    port: parsed.values.port ?? env.KLEX_MACHINE_PORT,
    logLevel: parsed.values['log-level'] ?? env.KLEX_MACHINE_LOG_LEVEL,
  };
  if (
    command === 'cloud' &&
    subcommand === 'enroll' &&
    value &&
    !extra.length
  ) {
    if (parsed.values.mode !== undefined) {
      throw new Error('--mode cannot be used with cloud enroll');
    }
    // Enroll-only runs never serve, so inherited serve settings must not
    // block enrollment.
    if (parsed.values.serve === false) {
      return {
        action: 'enroll',
        cloudBaseUrl,
        code: value,
        dataDir,
        serve: false,
      };
    }
    // Enrolled mode has no local listener or logger; only cwd applies.
    const localOnly = (['host', 'port', 'log-level'] as const).filter(
      (name) => parsed.values[name] !== undefined,
    );
    if (localOnly.length) {
      throw new Error(
        `${localOnly.map((name) => `--${name}`).join(', ')} only apply to --mode local`,
      );
    }
    return {
      action: 'enroll',
      cloudBaseUrl,
      code: value,
      config: await resolveRuntimeConfig({ cwd: raw.cwd }, processCwd),
      dataDir,
      serve: true,
      omitHostDetails,
    };
  }
  if (parsed.values.serve !== undefined) {
    throw new Error('--serve and --no-serve are only valid with cloud enroll');
  }
  if (
    command === 'cloud' &&
    subcommand === 'bootstrap' &&
    !value &&
    !extra.length
  ) {
    const enrollmentCodeFile =
      parsed.values['enrollment-code-file'] ??
      env.KLEX_MACHINE_ENROLLMENT_CODE_FILE;
    if (!enrollmentCodeFile) {
      throw new Error(
        'Managed bootstrap requires --enrollment-code-file <path|->',
      );
    }
    return {
      action: 'managed-bootstrap',
      cloudBaseUrl,
      config: await resolveRuntimeConfig(raw, processCwd),
      dataDir,
      enrollmentCodeFile,
      omitHostDetails,
    };
  }
  if (
    (command !== undefined && command !== 'serve') ||
    subcommand ||
    value ||
    extra.length > 0
  ) {
    throw new Error(
      'Expected command: klex-machine serve, klex-machine cloud enroll <code>, or klex-machine cloud bootstrap',
    );
  }
  const mode = parsed.values.mode ?? env.KLEX_MACHINE_MODE ?? 'enrolled';
  if (mode !== 'local' && mode !== 'enrolled' && mode !== 'managed') {
    throw new Error('Invalid mode. Expected local, enrolled, or managed.');
  }

  return {
    action: 'serve',
    config: await resolveRuntimeConfig(raw, processCwd),
    dataDir,
    mode,
    omitHostDetails,
  };
}

function omitHostDetailsFromEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (/^(1|true)$/i.test(value)) return true;
  if (/^(0|false)$/i.test(value)) return false;
  throw new Error(
    'Invalid KLEX_MACHINE_OMIT_HOST_DETAILS. Expected 1/true or 0/false.',
  );
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

export function machineLiveMessage(machineId: string): string {
  return `Machine ${machineId} is live. You can now assign it to Klex Bots.\nKeep this process running; press Ctrl+C to stop.`;
}

export function helpText(): string {
  return `klex-machine ${packageVersion()}

Usage:
  klex-machine serve [options]
  klex-machine cloud enroll <code> [--no-serve] [options]
  klex-machine cloud bootstrap --enrollment-code-file <path|-> [options]

Options:
  --cwd <path>        Default working directory
  --host <address>    Local mode listener address (default: 127.0.0.1)
  --port <number>     Local mode listener port (default: 3123)
  --log-level <level> Local mode: trace, debug, info, warn, error, or fatal
  --mode <mode>       local, enrolled, or managed (default: enrolled)
  --data-dir <path>   Identity and notification state directory (default: ~/.klex-machine)
  --cloud-base-url <url> Cloud API URL used for enrollment
  --enrollment-code-file <path|-> Read and remove a one-time code file, or read stdin with -
  --no-serve          Enroll only; do not start serving
  --omit-host-details Omit hostname, workspace path and disk size from Cloud facts.
                      Otherwise these are visible to organization members through the API.
                      Removes stored host details on the next accepted report.
  -h, --help          Show help
  -v, --version       Show version

cloud enroll serves after enrolling; keep the process running to stay
connected. Re-running it with the same code restarts without re-enrolling.

Environment:
  KLEX_MACHINE_CWD
  KLEX_MACHINE_HOST
  KLEX_MACHINE_PORT
  KLEX_MACHINE_LOG_LEVEL
  KLEX_MACHINE_MODE
  KLEX_MACHINE_DATA_DIR
  KLEX_MACHINE_CLOUD_BASE_URL
  KLEX_MACHINE_ENROLLMENT_CODE_FILE
  KLEX_MACHINE_OMIT_HOST_DETAILS (1/true or 0/false; default: false)`;
}
