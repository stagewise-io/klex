import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import {
  type ILogObj,
  type ILogObjMeta,
  type ISettings,
  type LogFormatter,
  type TLogLevelName,
  type Transport,
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

export type TelemetryLogLevel = 'no' | 'basic' | 'advanced' | 'debug';

export interface OTelLoggerOptions {
  url: string;
  headers?: Record<string, string>;
  resourceAttributes: Record<string, unknown>;
  minLevel?: LogLevel | number;
  /** Current remote telemetry policy, evaluated for every exported record. */
  telemetryLevel?: TelemetryLogLevel | (() => TelemetryLogLevel);
  /**
   * Trusted resource attributes that may change at runtime (for example an
   * enrolled cloud client id). Evaluated per record and merged over
   * `resourceAttributes`; the supplier owns any level gating.
   */
  dynamicResourceAttributes?: () => Record<string, unknown>;
  /**
   * Explicit `event.name` values exported below `minLevel` at `advanced` and
   * `debug`. Intended for fixed, metadata-only event records; free-form logs
   * stay subject to `minLevel`.
   */
  eventsBelowMinLevel?: readonly string[];
}

export interface OTelTransportControl {
  setMinLevel(level: LogLevel | number | undefined): void;
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

// --- canonical schema -------------------------------------------------------

/**
 * Maps shorthand field names onto the shared telemetry schema:
 * OpenTelemetry semantic-convention names where one exists (`gen_ai.*`,
 * `error.*`), otherwise the `klex.*` names also used by spans and metrics.
 */
const CANONICAL_FIELD_NAMES: Readonly<Record<string, string>> = {
  module: 'klex.module',
  event: 'event.name',
  source: 'klex.call.source',
  outcome: 'klex.outcome',
  operation: 'klex.operation.name',
  operationName: 'klex.operation.name',
  provider: 'gen_ai.provider.name',
  providerType: 'klex.model.provider_type',
  providerId: 'klex.model.provider_id',
  modelType: 'gen_ai.request.model',
  sessionId: 'klex.session.id',
  sessionName: 'klex.session.name',
  sessionKind: 'klex.session.kind',
  sessionParentId: 'klex.session.parent.id',
  sessionExtension: 'klex.session.extension',
  stateFrom: 'klex.session.state.from',
  stateTo: 'klex.session.state.to',
  stateValue: 'klex.session.state.value',
  lifecycleEvent: 'klex.session.lifecycle.event',
  retryReason: 'klex.retry.reason',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  durationMs: 'duration_ms',
  errorType: 'error.type',
  errorCode: 'error.code',
  finishReason: 'gen_ai.response.finish_reasons',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
  cacheWriteTokens: 'gen_ai.usage.cache_creation.input_tokens',
  ttftMs: 'klex.time_to_first_chunk_ms',
  stepCount: 'klex.step.count',
  mcpCount: 'klex.mcp.count',
};

/** Semantic-convention fields whose value is an array of strings. */
const STRING_ARRAY_FIELDS = new Set(['gen_ai.response.finish_reasons']);

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function canonicalFieldName(key: string): string {
  if (CANONICAL_FIELD_NAMES[key]) return CANONICAL_FIELD_NAMES[key];
  if (key.includes('.')) {
    return key
      .split('.')
      .map((segment) => toSnakeCase(segment))
      .join('.');
  }
  return toSnakeCase(key);
}

function normalizeStructuredFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  // Explicit canonical fields win over compatibility aliases regardless of
  // insertion order.
  for (const [key, value] of Object.entries(fields)) {
    const canonical = canonicalFieldName(key);
    if (canonical === key) output[canonical] = value;
  }
  for (const [key, value] of Object.entries(fields)) {
    const canonical = canonicalFieldName(key);
    if (!(canonical in output)) output[canonical] = value;
  }
  for (const key of STRING_ARRAY_FIELDS) {
    if (typeof output[key] === 'string') output[key] = [output[key]];
  }
  return output;
}

function eventName(loggerName: string | undefined, message: string): string {
  const namespace = toSnakeCase(loggerName || 'klex').replace(/_+/g, '.');
  const action = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 96);
  return `${namespace}.${action || 'log'}`;
}

function isStructuredFields(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

function normalizeLogArguments(
  args: unknown[],
  loggerName: string | undefined,
): unknown[] {
  const objectIndex = isStructuredFields(args[0])
    ? 0
    : isStructuredFields(args[1])
      ? 1
      : -1;
  const message =
    typeof args[0] === 'string'
      ? args[0]
      : typeof args[1] === 'string'
        ? args[1]
        : '';

  if (objectIndex < 0 && !message) return args;

  const fields = normalizeStructuredFields(
    objectIndex >= 0 ? (args[objectIndex] as Record<string, unknown>) : {},
  );
  fields['event.name'] ??= eventName(loggerName, message);
  fields['logger.name'] ??= loggerName || 'klex';

  if (objectIndex >= 0) {
    const normalized = [...args];
    normalized[objectIndex] = fields;
    return normalized;
  }
  return [fields, message];
}

// --- factory ----------------------------------------------------------------

export function createLogger(opts?: LoggerOptions): RootLogger {
  const verbose = opts?.verbose ?? true;
  const consoleOutput = opts?.console !== false;

  const logger = new TslogLogger<ILogObj>({
    name: opts?.name,
    // An explicit minimum (e.g. TRACE for telemetry debug) always wins; capture
    // only raises the default so the local log store sees DEBUG records.
    minLevel: opts?.minLevel ?? (opts?.capture || verbose ? 'DEBUG' : 'INFO'),
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

  logger.use((logContext) => {
    logContext.args = normalizeLogArguments(
      logContext.args,
      logContext.settings.name,
    );
    return logContext;
  });

  if (opts?.capture) {
    const capture = opts.capture;
    let sequence = 0;
    // tslog v5 stores metadata under `settings.meta.property` (`_logMeta`).
    const metaProperty = logger.settings.meta?.property ?? '_logMeta';
    logger.attachTransport((record) => {
      const recordObj = record as Record<string, unknown>;
      const meta = recordObj[metaProperty] as
        | { date?: Date; logLevelName?: string; name?: string }
        | undefined;
      capture({
        timestamp: meta?.date ?? new Date(),
        level: meta?.logLevelName ?? 'INFO',
        loggerName: meta?.name ?? '',
        message: extractMessage(recordObj),
        fields: extractFields(recordObj, metaProperty),
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

/** `basic`: aggregate, non-identifying fields only. */
const BASIC_OTEL_FIELDS = new Set([
  'klex.module',
  'event.name',
  'logger.name',
  'klex.call.source',
  'klex.outcome',
  'klex.operation.name',
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'klex.model.provider_type',
  'gen_ai.response.finish_reasons',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'klex.time_to_first_chunk_ms',
  'duration_ms',
  'error.type',
  'error.code',
  'count',
  'delta',
]);

/** Credential-bearing field names. Redacted at every level. */
const CREDENTIAL_LOG_FIELD_PATTERN =
  /(?:api[_-]?key|authorization|cookie|credentials?|password|secret|(?:^|[._-])(?:access|auth|refresh)?[_-]?token(?:$|[._-])|headers?)/i;
/** Host/person-identifying field names. Redacted below `debug`. */
const PRIVACY_LOG_FIELD_PATTERN =
  /(?:^|[._-])(?:host(?:name)?|user(?:name)?|home|mac|ip|email|phone)(?:$|[._-])/i;
/**
 * User/model content, matched against each dot-separated name segment whose
 * final snake_case word is a content noun (`text`, `tool_result`,
 * `input_messages`) — but not counters such as `input_tokens`.
 */
const CONTENT_LOG_SEGMENT_PATTERN =
  /(?:^|_)(?:prompts?|completions?|instructions?|messages?|contents?|text|body|arguments?|args|inputs?|outputs?|results?|transcripts?|summary|query)$/i;

function isContentLogField(key: string): boolean {
  return key
    .split('.')
    .some((segment) => CONTENT_LOG_SEGMENT_PATTERN.test(toSnakeCase(segment)));
}

function isSensitiveAdvancedField(key: string): boolean {
  return (
    CREDENTIAL_LOG_FIELD_PATTERN.test(key) ||
    PRIVACY_LOG_FIELD_PATTERN.test(key) ||
    isContentLogField(key)
  );
}

function scrubCredentials(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(?:api[_-]?key|token|secret|password)[=:]\s*[^\s,;&]+/gi,
      '[REDACTED]',
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** `basic`/`advanced`: credentials and every URL are removed. */
function sanitizeOtelString(value: string, maxLength = 512): string {
  return scrubCredentials(value)
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, '[URL_REDACTED]')
    .slice(0, maxLength);
}

function sanitizeOtelValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeOtelString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .filter(
        (entry) =>
          typeof entry === 'string' ||
          typeof entry === 'number' ||
          typeof entry === 'boolean',
      )
      .slice(0, 32)
      .map((entry) => sanitizeOtelValue(entry));
  }
  if (value instanceof Error) return { name: value.name };
  return '[REDACTED]';
}

/**
 * `advanced`: every field is kept, but credential, host/person, and content
 * field names are redacted at any depth, strings lose URLs and are capped,
 * and errors are reduced to their type and code.
 */
function sanitizeAdvancedOtelValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[MAX_DEPTH]';
  if (typeof value === 'string') return sanitizeOtelString(value);
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (value instanceof Error) return errorSummary(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((entry) => sanitizeAdvancedOtelValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .map(([key, entry]) => [
          key,
          isSensitiveAdvancedField(key)
            ? '[REDACTED]'
            : sanitizeAdvancedOtelValue(entry, depth + 1),
        ]),
    );
  }
  return '[REDACTED]';
}

function errorSummary(value: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const type = errorType(value);
  if (type) summary.name = type;
  const code =
    value && typeof value === 'object'
      ? (value as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string' || typeof code === 'number') {
    summary.code = code;
  }
  return summary;
}

/** `debug`: only credentials are removed; content, URLs and paths are kept. */
function sanitizeDebugOtelString(value: string): string {
  return scrubCredentials(value).slice(0, 65_536);
}

function sanitizeFullOtelValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') return sanitizeDebugOtelString(value);
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeDebugOtelString(value.message),
      ...(value.stack ? { stack: sanitizeDebugOtelString(value.stack) } : {}),
      ...(value.cause !== undefined
        ? { cause: sanitizeFullOtelValue(value.cause, depth + 1) }
        : {}),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((entry) => sanitizeFullOtelValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 128)
        .map(([key, entry]) => [
          key,
          CREDENTIAL_LOG_FIELD_PATTERN.test(key)
            ? '[REDACTED]'
            : sanitizeFullOtelValue(entry, depth + 1),
        ]),
    );
  }
  return String(value);
}

function errorType(value: unknown): string | undefined {
  if (value instanceof Error) return value.name;
  if (value && typeof value === 'object') {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function sanitizeOtelRecord(
  record: ILogObj,
  metadataProperty: string,
  messageKey: string,
  level: Exclude<TelemetryLogLevel, 'no'> = 'basic',
): ILogObj {
  const source = record as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const metadata = source[metadataProperty];
  if (metadata && typeof metadata === 'object') {
    output[metadataProperty] = metadata;
  }

  const message = extractMessage(source);
  // `basic` exports aggregate fields only; message bodies are free text.
  if (message && level !== 'basic') {
    output[messageKey] =
      level === 'debug'
        ? sanitizeDebugOtelString(message)
        : sanitizeOtelString(message);
  }

  const fields = normalizeStructuredFields(
    extractFields(source, metadataProperty) ?? {},
  );
  const loggerName =
    metadata && typeof metadata === 'object'
      ? (metadata as { name?: unknown }).name
      : undefined;
  const loggerNameValue =
    typeof loggerName === 'string' ? loggerName : undefined;
  const derivedEventName = eventName(loggerNameValue, message);
  // At `basic`, an event name derived from the message would re-export the
  // message text, so only explicit names survive.
  if (level === 'basic' && fields['event.name'] === derivedEventName) {
    fields['event.name'] = eventName(loggerNameValue, '');
  }
  fields['event.name'] ??=
    level === 'basic' ? eventName(loggerNameValue, '') : derivedEventName;
  fields['logger.name'] ??=
    typeof loggerName === 'string' ? loggerName : 'klex';

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'error') {
      const type = errorType(value);
      if (type && !('error.type' in fields)) output['error.type'] = type;
      if (level === 'debug') output.error = sanitizeFullOtelValue(value);
      else if (level === 'advanced') output.error = errorSummary(value);
      continue;
    }
    if (level === 'basic') {
      if (BASIC_OTEL_FIELDS.has(key)) output[key] = sanitizeOtelValue(value);
      continue;
    }
    if (level === 'advanced') {
      output[key] = isSensitiveAdvancedField(key)
        ? '[REDACTED]'
        : sanitizeAdvancedOtelValue(value);
      continue;
    }
    output[key] = CREDENTIAL_LOG_FIELD_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeFullOtelValue(value);
  }

  return output as ILogObj;
}

const LOG_LEVEL_IDS: Record<string, number> = {
  SILLY: 0,
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ERROR: 5,
  FATAL: 6,
};

/** Exempt events are emitted at INFO; lower levels are never exempt. */
const EXEMPT_EVENT_MIN_LEVEL_ID = LOG_LEVEL_IDS.INFO as number;

function levelId(level: LogLevel | number): number {
  return typeof level === 'number'
    ? level
    : (LOG_LEVEL_IDS[level.toUpperCase()] ?? 0);
}

export function attachOtelTransport(
  logger: RootLogger,
  options: OTelLoggerOptions,
  verbose = true,
): OTelTransportControl {
  const createFormatter = (resource: Record<string, unknown>) =>
    otlpFormat({
      resource,
      getSpanContext: () => {
        const spanContext = trace.getSpan(context.active())?.spanContext();
        return spanContext && isSpanContextValid(spanContext)
          ? spanContext
          : undefined;
      },
    }) as unknown as LogFormatter<ILogObj>;
  let otlpFormatter = createFormatter(options.resourceAttributes);
  let dynamicKey = '';
  // tslog binds the resource when the formatter is created, so rebuild it only
  // when the dynamic attributes actually change.
  const currentFormatter = (): LogFormatter<ILogObj> => {
    if (!options.dynamicResourceAttributes) return otlpFormatter;
    let dynamic: Record<string, unknown> = {};
    try {
      dynamic = options.dynamicResourceAttributes();
    } catch {
      // Telemetry is fail-open: keep the last known resource.
      return otlpFormatter;
    }
    const key = JSON.stringify(dynamic);
    if (key !== dynamicKey) {
      dynamicKey = key;
      otlpFormatter = createFormatter({
        ...options.resourceAttributes,
        ...dynamic,
      });
    }
    return otlpFormatter;
  };
  const currentLevel = (): TelemetryLogLevel =>
    typeof options.telemetryLevel === 'function'
      ? options.telemetryLevel()
      : (options.telemetryLevel ?? 'basic');
  const metadataProperty = logger.settings.meta?.property ?? '_logMeta';
  const exemptEvents = new Set(options.eventsBelowMinLevel ?? []);
  let minLevel: LogLevel | number | undefined =
    'minLevel' in options ? options.minLevel : verbose ? undefined : 'INFO';
  // tslog filters by the transport minimum before formatting. Exempt events
  // need a lower transport minimum; `write` then applies the real threshold.
  const transportMinLevel = (): LogLevel | number | undefined => {
    if (exemptEvents.size === 0 || minLevel === undefined) return minLevel;
    return Math.min(levelId(minLevel), EXEMPT_EVENT_MIN_LEVEL_ID);
  };
  const shouldExport = (record: ILogObj, level: TelemetryLogLevel): boolean => {
    if (level === 'no') return false;
    if (minLevel === undefined) return true;
    const source = record as Record<string, unknown>;
    const metadata = source[metadataProperty] as
      | { logLevelId?: unknown }
      | undefined;
    const recordLevel =
      typeof metadata?.logLevelId === 'number' ? metadata.logLevelId : 0;
    if (recordLevel >= levelId(minLevel)) return true;
    if (level !== 'advanced' && level !== 'debug') return false;
    const name = extractFields(source, metadataProperty)?.['event.name'];
    return (
      typeof name === 'string' &&
      exemptEvents.has(name) &&
      recordLevel >= EXEMPT_EVENT_MIN_LEVEL_ID
    );
  };
  const transport = httpTransport<ILogObj>({
    url: options.url,
    format: (record, settings) => {
      const level = currentLevel();
      // `no` records are dropped in `write`; the most restrictive projection
      // keeps the formatter total.
      return currentFormatter()(
        sanitizeOtelRecord(
          record,
          metadataProperty,
          settings.json.messageKey,
          level === 'no' ? 'basic' : level,
        ) as ILogObjMeta,
        settings,
      );
    },
    encodeBody: otlpBatchBody,
    name: 'otlp',
    headers: options.headers,
    batchSize: 100,
    flushIntervalMs: 5_000,
    maxBufferedLines: 10_000,
    timeoutMs: 10_000,
  });
  // `no` must suppress export entirely, including when the level is
  // resolved dynamically per record.
  const gatedTransport: Transport<ILogObj> = {
    name: transport.name,
    format: transport.format,
    write: (record, line) =>
      shouldExport(record, currentLevel())
        ? transport.write(record, line)
        : undefined,
    ...(transport.flush
      ? { flush: () => transport.flush?.() ?? Promise.resolve() }
      : {}),
    ...(transport[Symbol.asyncDispose]
      ? {
          [Symbol.asyncDispose]: () =>
            transport[Symbol.asyncDispose]?.() ?? Promise.resolve(),
        }
      : {}),
  };
  gatedTransport.minLevel = transportMinLevel();
  logger.attachTransport(gatedTransport);
  return {
    setMinLevel(level) {
      minLevel = level;
      gatedTransport.minLevel = transportMinLevel();
    },
  };
}
