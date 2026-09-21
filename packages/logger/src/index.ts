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

export interface CapturedLogEntry {
  timestamp: Date;
  level: string;
  loggerName: string;
  message: string;
  fields: Record<string, unknown> | null;
  sequence: number;
}

export interface OTelLoggerOptions {
  url: string;
  headers?: Record<string, string>;
  resourceAttributes: Record<string, unknown>;
  minLevel?: LogLevel | number;
}

export interface LoggerOptions {
  name?: string;
  minLevel?: LogLevel;
  type?: 'json' | 'pretty' | 'hidden';
  verbose?: boolean;
  capture?: (entry: CapturedLogEntry) => void;
  /** When false, suppresses all console output (for TUI mode). Default: true */
  console?: boolean;
  mask?: {
    keys?: string[];
    caseInsensitive?: boolean;
  };
  otel?: OTelLoggerOptions;
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
    minLevel: opts?.capture
      ? 'DEBUG'
      : verbose
        ? (opts?.minLevel ?? 'DEBUG')
        : 'INFO',
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

  if (opts?.capture) {
    const capture = opts.capture;
    let sequence = 0;
    logger.attachTransport((record) => {
      const recordObj = record as Record<string, unknown>;
      const meta = recordObj['_meta'] as
        | { date?: Date; logLevelName?: string; name?: string }
        | undefined;
      capture({
        timestamp: meta?.date ?? new Date(),
        level: meta?.logLevelName ?? 'INFO',
        loggerName: meta?.name ?? '',
        message: extractMessage(recordObj),
        fields: extractFields(recordObj, '_meta'),
        sequence: sequence++,
      });
    });
  }

  if (!verbose && consoleOutput) {
    logger.attachTransport({
      name: 'compact-console',
      minLevel: 'INFO',
      format: compactFormatter,
      write: (_record, line) => {
        console.log(line);
      },
    });
  }

  if (opts?.otel) {
    attachOtelTransport(logger, opts.otel, verbose);
  }

  return logger;
}

const SAFE_OTEL_FIELDS = new Set([
  'module',
  'operation',
  'provider',
  'providerType',
  'modelType',
  'count',
  'durationMs',
  'inputTokens',
  'outputTokens',
  'stepCount',
  'mcpCount',
  'errorType',
  'errorCode',
  'event',
]);

function sanitizeOtelString(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(?:api[_-]?key|token|secret|password)[=:]\s*[^\s,;]+/gi,
      '[REDACTED]',
    )
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, '[URL_REDACTED]')
    .slice(0, 512);
}

function sanitizeOtelValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeOtelString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name };
  return '[REDACTED]';
}

function sanitizeOtelRecord(
  record: ILogObj,
  metadataProperty: string,
): ILogObj {
  const source = record as Record<PropertyKey, unknown>;
  const output: Record<PropertyKey, unknown> = {};

  // The OTLP formatter reads tslog metadata through the configured property.
  // Copy only that metadata object; symbols can retain the original masked
  // argument array, including arbitrary message bodies.
  const metadata = source[metadataProperty];
  if (metadata && typeof metadata === 'object') {
    output[metadataProperty] = metadata;
  }

  const structuredFields = source['0'];
  if (structuredFields && typeof structuredFields === 'object') {
    const safeFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(structuredFields)) {
      if (SAFE_OTEL_FIELDS.has(key)) safeFields[key] = sanitizeOtelValue(value);
    }
    output['0'] = safeFields;
  }

  if (source['1'] && typeof source['1'] === 'object') {
    const safeFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source['1'])) {
      if (SAFE_OTEL_FIELDS.has(key)) safeFields[key] = sanitizeOtelValue(value);
    }
    output['1'] = safeFields;
  }

  for (const key of Object.keys(source)) {
    if (key === '_meta' || key === '0' || key === '1') continue;
    if (SAFE_OTEL_FIELDS.has(key)) output[key] = sanitizeOtelValue(source[key]);
  }
  return output as ILogObj;
}

export function attachOtelTransport(
  logger: RootLogger,
  options: OTelLoggerOptions,
  verbose = true,
): void {
  const otlpFormatter = otlpFormat({
    resource: options.resourceAttributes,
  }) as unknown as LogFormatter<ILogObj>;
  const transport = httpTransport<ILogObj>({
    url: options.url,
    format: (record, settings) => {
      const metadataProperty = settings.meta?.property ?? '_logMeta';
      return otlpFormatter(
        sanitizeOtelRecord(record, metadataProperty) as ILogObjMeta,
        settings,
      );
    },
    encodeBody: otlpBatchBody,
    name: 'otlp',
    headers: options.headers,
  });
  if ('minLevel' in options) {
    transport.minLevel = options.minLevel;
  } else if (!verbose) {
    transport.minLevel = 'INFO';
  }
  logger.attachTransport(transport);
}
