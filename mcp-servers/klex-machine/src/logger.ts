import { type ILogObj, Logger } from 'tslog';
import { err, serialize } from 'tslog/serializers';

export type MachineLogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal';

export type MachineLogger = Pick<
  Logger<ILogObj>,
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
>;

const LEVEL_PRIORITY = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
} as const satisfies Record<MachineLogLevel, number>;

export function createMachineLogger(
  minLevel: MachineLogLevel,
): Logger<ILogObj> {
  const logger = new Logger<ILogObj>({
    name: 'klex-machine',
    minLevel: LEVEL_PRIORITY[minLevel],
    type: 'hidden',
    middleware: [serialize({ error: err })],
    mask: {
      keys: [
        'password',
        'apiKey',
        'authorization',
        'token',
        'secret',
        'prompt',
      ],
      caseInsensitive: true,
    },
  });
  logger.attachTransport({
    name: 'stderr',
    format: process.stderr.isTTY ? 'pretty' : 'json',
    write: (_record, line) => {
      process.stderr.write(`${line}\n`);
    },
  });
  return logger;
}

export const silentMachineLogger: MachineLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
};
