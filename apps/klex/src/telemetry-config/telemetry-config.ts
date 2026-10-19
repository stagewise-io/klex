export const TELEMETRY_ENDPOINT_ENV = 'KLEX_TELEMETRY_ENDPOINT';
export const TELEMETRY_HEADERS_ENV = 'KLEX_TELEMETRY_HEADERS';
export const TELEMETRY_DEBUG_ENV = 'KLEX_TELEMETRY_DEBUG';
export const TELEMETRY_DISABLE_ENV = 'KLEX_DISABLE_TELEMETRY';
export const TELEMETRY_LEVEL_ENV = 'KLEX_TELEMETRY_LEVEL';
export const TELEMETRY_ALLOW_INSECURE_ENV = 'KLEX_TELEMETRY_ALLOW_INSECURE';

/**
 * Process-wide telemetry level. Telemetry is off unless an endpoint is given;
 * an endpoint alone enables `advanced`. `basic` and `debug` are explicit
 * opt-ins through the level setting (`debug` also through the debug flag).
 */
export type TelemetryMode = 'no' | 'basic' | 'advanced' | 'debug';

/** Levels that can be requested explicitly; `no` is expressed by disabling. */
export type ExplicitTelemetryLevel = Exclude<TelemetryMode, 'no'>;

const EXPLICIT_TELEMETRY_LEVELS: readonly ExplicitTelemetryLevel[] = [
  'basic',
  'advanced',
  'debug',
];

/**
 * Parses an explicit level. Blank means "not set"; anything other than an
 * exact level name is a startup error rather than a silent fallback.
 */
export function parseTelemetryLevel(
  value: string | undefined,
): ExplicitTelemetryLevel | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const level = EXPLICIT_TELEMETRY_LEVELS.find((item) => item === candidate);
  if (level === undefined) {
    throw new Error(
      `Invalid telemetry level: ${candidate} (expected ${EXPLICIT_TELEMETRY_LEVELS.join(', ')})`,
    );
  }
  return level;
}

export interface TelemetryModeInput {
  /** Resolved endpoint, or undefined when none was supplied. */
  endpoint: string | undefined;
  debug: boolean;
  disabled: boolean;
  /** Explicit level, or undefined to derive it from endpoint and debug. */
  level?: ExplicitTelemetryLevel;
}

export function resolveTelemetryMode(input: TelemetryModeInput): TelemetryMode {
  if (input.disabled) return 'no';
  if (input.level !== undefined) {
    if (input.endpoint === undefined) {
      throw new Error(
        `Telemetry level ${input.level} requires an endpoint: set --telemetry-endpoint or ${TELEMETRY_ENDPOINT_ENV}`,
      );
    }
    if (input.debug && input.level !== 'debug') {
      throw new Error(
        `Debug telemetry conflicts with telemetry level ${input.level}: unset --telemetry-debug / ${TELEMETRY_DEBUG_ENV} or --telemetry-level / ${TELEMETRY_LEVEL_ENV}`,
      );
    }
    return input.level;
  }
  if (input.endpoint === undefined) {
    if (input.debug) {
      throw new Error(
        `Debug telemetry requires an endpoint: set --telemetry-endpoint or ${TELEMETRY_ENDPOINT_ENV}`,
      );
    }
    return 'no';
  }
  return input.debug ? 'debug' : 'advanced';
}

export interface TelemetryEndpointOptions {
  /**
   * Accept plain `http:` for any host. Meant for cluster-internal collectors;
   * without it, HTTP is allowed only for loopback.
   */
  readonly allowInsecure?: boolean;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** True for a plain-HTTP endpoint that leaves the machine. */
export function isInsecureTelemetryEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    !LOOPBACK_HOSTS.includes(url.hostname.toLowerCase())
  );
}

export interface TelemetryExportConfiguration {
  readonly endpoint: string;
  readonly logsUrl: string;
  readonly tracesUrl: string;
  readonly metricsUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Returns undefined for a missing or blank value; there is no default endpoint. */
export function resolveTelemetryEndpoint(
  value: string | undefined,
  options: TelemetryEndpointOptions = {},
): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid telemetry endpoint: ${candidate}`);
  }
  const isLoopbackHttp =
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.includes(url.hostname.toLowerCase());
  const isAllowedHttp =
    url.protocol === 'http:' && (isLoopbackHttp || options.allowInsecure);
  if (url.protocol !== 'https:' && !isAllowedHttp) {
    throw new Error(
      `Telemetry endpoint must use HTTPS (HTTP is allowed only for localhost, or with --telemetry-allow-insecure / ${TELEMETRY_ALLOW_INSECURE_ENV})`,
    );
  }
  if (url.username || url.password) {
    throw new Error('Telemetry endpoint must not contain credentials');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function createTelemetryExportConfiguration(
  endpoint: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  options: TelemetryEndpointOptions = {},
): TelemetryExportConfiguration {
  const resolvedEndpoint = resolveTelemetryEndpoint(endpoint, options);
  if (resolvedEndpoint === undefined) {
    throw new Error('Telemetry endpoint must not be empty');
  }
  const headers = parseHeaders(env[TELEMETRY_HEADERS_ENV]);
  // Headers usually carry collector tokens; never send them in cleartext.
  if (
    Object.keys(headers).length > 0 &&
    isInsecureTelemetryEndpoint(resolvedEndpoint)
  ) {
    throw new Error(
      `${TELEMETRY_HEADERS_ENV} must not be sent over plain HTTP; use an HTTPS endpoint`,
    );
  }
  return {
    endpoint: resolvedEndpoint,
    logsUrl: `${resolvedEndpoint}/v1/logs`,
    tracesUrl: `${resolvedEndpoint}/v1/traces`,
    metricsUrl: `${resolvedEndpoint}/v1/metrics`,
    headers,
  };
}

export interface TelemetryWarning {
  readonly mode: Exclude<TelemetryMode, 'no'>;
  readonly title: string;
  readonly lines: readonly string[];
}

/** User-facing notice for active telemetry; undefined when telemetry is off. */
export function describeTelemetryWarning(
  mode: TelemetryMode,
  endpoint: string | undefined,
): TelemetryWarning | undefined {
  if (mode === 'no' || endpoint === undefined) return undefined;
  const transport = isInsecureTelemetryEndpoint(endpoint)
    ? ['Telemetry is sent unencrypted over HTTP.']
    : [];
  if (mode === 'basic') {
    return {
      mode,
      title: 'Telemetry is enabled (basic)',
      lines: [
        `Metrics and warning logs are exported to ${endpoint}.`,
        'Traces, chat content, names, and credentials are excluded.',
        ...transport,
      ],
    };
  }
  if (mode === 'advanced') {
    return {
      mode,
      title: 'Telemetry is enabled',
      lines: [
        `Logs, metrics, and traces are exported to ${endpoint}.`,
        'Chat content, message text, and credentials are excluded.',
        ...transport,
      ],
    };
  }
  return {
    mode,
    title: 'DEBUG TELEMETRY IS ENABLED',
    lines: [
      `Everything is exported to ${endpoint}, including chat content,`,
      'prompts, tool payloads, full error details, file paths, and other',
      'personal information (PII).',
      'Use only with a collector you control. Restart without',
      `--telemetry-debug / ${TELEMETRY_DEBUG_ENV} to stop.`,
      ...transport,
    ],
  };
}

/** Plain-text rendering of the warning for headless (stderr) output. */
export function formatTelemetryWarning(warning: TelemetryWarning): string {
  const rows = [warning.title, '', ...warning.lines];
  const width = Math.max(...rows.map((row) => row.length));
  const border = warning.mode === 'debug' ? '#' : '-';
  const edge = warning.mode === 'debug' ? '#' : '|';
  const rule = border.repeat(width + 4);
  const body = rows.map((row) => `${edge} ${row.padEnd(width)} ${edge}`);
  const frame = [rule, ...body, rule];
  return `\n${(warning.mode === 'debug' ? [rule, ...frame, rule] : frame).join('\n')}\n\n`;
}

function parseHeaders(
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${TELEMETRY_HEADERS_ENV} must contain a JSON object`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${TELEMETRY_HEADERS_ENV} must contain a JSON object`);
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, item]) => {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) {
        throw new Error(
          `${TELEMETRY_HEADERS_ENV} contains an invalid header name`,
        );
      }
      if (typeof item !== 'string') {
        throw new Error(`${TELEMETRY_HEADERS_ENV} values must be strings`);
      }
      const hasControlCharacter = [...item].some((character) => {
        const code = character.charCodeAt(0);
        return (
          code <= 0x08 ||
          (code >= 0x0a && code <= 0x0c) ||
          (code >= 0x0e && code <= 0x1f) ||
          code === 0x7f
        );
      });
      if (hasControlCharacter) {
        throw new Error(
          `${TELEMETRY_HEADERS_ENV} contains an invalid header value`,
        );
      }
      return [key, item];
    }),
  );
}
