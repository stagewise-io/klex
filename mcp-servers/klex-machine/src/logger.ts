export type MachineLogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal';

export interface MachineLogger {
  info(data: unknown, message: string): void;
  warn(data: unknown, message: string): void;
  error(data: unknown, message: string): void;
}

const LEVEL_PRIORITY = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const satisfies Record<MachineLogLevel, number>;

export function createMachineLogger(minLevel: MachineLogLevel): MachineLogger {
  const write = (
    level: 'info' | 'warn' | 'error',
    data: unknown,
    message: string,
  ) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;
    process.stderr.write(
      `${new Date().toISOString()} ${level.toUpperCase()} ${message} ${JSON.stringify(data)}\n`,
    );
  };
  return {
    info: (data, message) => write('info', data, message),
    warn: (data, message) => write('warn', data, message),
    error: (data, message) => write('error', data, message),
  };
}

export const silentMachineLogger: MachineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
