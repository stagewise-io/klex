import {
  type ILogObj,
  type ILogObjMeta,
  type ISettings,
  type LogFormatter,
  type TLogLevelName,
  Logger as TslogLogger,
} from 'tslog';
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
  verbose?: boolean;
  /** When false, suppresses all console output (for TUI mode). Default: true */
  console?: boolean;
  mask?: {
    keys?: string[];
    caseInsensitive?: boolean;
  };
  otel?: {
    url: string;
    resourceAttributes: Record<string, unknown>;
  };
}

// --- compact formatter ------------------------------------------------------

const MAX_FIELD_JSON_LENGTH = 200;

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === 'bigint') return String(val);
    if (typeof val === 'undefined') return '[undefined]';
    if (val instanceof Error) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
        ...(val.cause !== undefined ? { cause: val.cause } : {}),
      };
    }
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  };
  return JSON.stringify(value, replacer);
}

function truncateJson(json: string): string {
  if (json.length <= MAX_FIELD_JSON_LENGTH) return json;
  return `${json.slice(0, MAX_FIELD_JSON_LENGTH)}…`;
}

function extractMessage(record: Record<string, unknown>): string {
  if (
    typeof record['0'] === 'object' &&
    record['0'] !== null &&
    typeof record['1'] === 'string'
  ) {
    return record['1'] as string;
  }
  if (typeof record['0'] === 'string') {
    return record['0'] as string;
  }
  return '';
}

function extractFields(
  record: Record<string, unknown>,
  metaProperty: string,
): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};

  if (typeof record['0'] === 'object' && record['0'] !== null) {
    const obj = record['0'] as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== '__proto__') fields[key] = obj[key];
    }
    return Object.keys(fields).length > 0 ? fields : null;
  }

  if (
    typeof record['0'] === 'string' &&
    typeof record['1'] === 'object' &&
    record['1'] !== null
  ) {
    const obj = record['1'] as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== '__proto__') fields[key] = obj[key];
    }
    return Object.keys(fields).length > 0 ? fields : null;
  }

  for (const key of Object.keys(record)) {
    if (
      key === metaProperty ||
      key === '0' ||
      key === '1' ||
      key === '__proto__'
    )
      continue;
    fields[key] = record[key];
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

const LEVEL_COLORS: Record<string, string> = {
  TRACE: '\x1b[35m', // purple (magenta)
  DEBUG: '\x1b[33m', // yellow
  INFO: '\x1b[34m', // blue
  WARN: '\x1b[38;5;208m', // orange
  ERROR: '\x1b[31m', // red
  FATAL: '\x1b[31m', // red
  LOG: '\x1b[30m', // black
};

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';

const compactFormatter: LogFormatter<ILogObj> = (
  record: ILogObj & ILogObjMeta,
  settings: ISettings<ILogObj>,
): string => {
  const metaProperty = settings.meta.property;
  const meta = (record as Record<string, unknown>)[metaProperty] as
    | { date: Date; logLevelName: string; name?: string }
    | undefined;

  if (!meta) return '';

  const time = formatTime(meta.date);
  const loggerName = meta.name ?? '';
  const levelColor = LEVEL_COLORS[meta.logLevelName] ?? '';
  const styledName = `${ANSI_BOLD}${levelColor}${loggerName}${ANSI_RESET}`;

  const recordObj = record as Record<string, unknown>;
  const message = extractMessage(recordObj);

  let line = `${time}|${styledName}: ${message}`;

  const levelName = meta.logLevelName;
  if (levelName === 'WARN' || levelName === 'ERROR' || levelName === 'FATAL') {
    const fields = extractFields(recordObj, metaProperty);
    if (fields) {
      line += ` ${truncateJson(safeStringify(fields))}`;
    }
  }

  return line;
};

// --- factory ----------------------------------------------------------------

export function createLogger(opts?: LoggerOptions): RootLogger {
  const verbose = opts?.verbose ?? true;
  const consoleOutput = opts?.console !== false;

  const logger = new TslogLogger<ILogObj>({
    name: opts?.name,
    minLevel: verbose ? (opts?.minLevel ?? 'INFO') : 'INFO',
    type: consoleOutput
      ? verbose
        ? (opts?.type ?? 'pretty')
        : 'hidden'
      : 'hidden',
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

  if (!verbose && consoleOutput) {
    logger.attachTransport({
      name: 'compact-console',
      format: compactFormatter,
      write: (_record, line) => {
        console.log(line);
      },
    });
  }

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
