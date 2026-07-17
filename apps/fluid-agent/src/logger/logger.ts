import { Logger as TslogLogger, type ILogObj, type TLogLevelName } from 'tslog';

export type RootLogger = TslogLogger<ILogObj>;

export type ModuleLogger = Pick<
  TslogLogger<ILogObj>,
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
>;

export type LogLevel = TLogLevelName;

export interface LoggerOptions {
  name?: string;
  minLevel?: LogLevel;
  type?: 'json' | 'pretty' | 'hidden';
  mask?: {
    keys?: string[];
    caseInsensitive?: boolean;
  };
}

export function createLogger(opts?: LoggerOptions): RootLogger {
  return new TslogLogger<ILogObj>({
    name: opts?.name,
    minLevel: opts?.minLevel ?? 'INFO',
    type: opts?.type ?? 'pretty',
    mask: opts?.mask
      ? {
          keys: opts.mask.keys ?? [
            'password',
            'apiKey',
            'authorization',
            'token',
            'prompt',
          ],
          caseInsensitive: opts.mask.caseInsensitive ?? true,
        }
      : undefined,
  });
}
