import { type ILogObj, type TLogLevelName, Logger as TslogLogger } from 'tslog';
import { otlpBatchBody, otlpFormat } from 'tslog/otel';
import { httpTransport } from 'tslog/transports/http';

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
  otel?: {
    url: string;
    resourceAttributes: Record<string, unknown>;
  };
}

export function createLogger(opts?: LoggerOptions): RootLogger {
  const logger = new TslogLogger<ILogObj>({
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

  if (opts?.otel) {
    logger.attachTransport(
      httpTransport({
        url: opts.otel.url,
        format: otlpFormat({ resource: opts.otel.resourceAttributes }),
        encodeBody: otlpBatchBody,
        name: 'otlp',
      }),
    );
  }

  return logger;
}
