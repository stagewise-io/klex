export const TELEMETRY_ENDPOINT_ENV = 'KLEX_TELEMETRY_ENDPOINT';
export const TELEMETRY_HEADERS_ENV = 'KLEX_TELEMETRY_HEADERS';
export const TELEMETRY_DEBUG_ENV = 'KLEX_TELEMETRY_DEBUG';
export const TELEMETRY_DISABLE_ENV = 'KLEX_DISABLE_TELEMETRY';

/**
 * Process-wide telemetry level. Telemetry is off unless an endpoint is given;
 * an endpoint enables `advanced`, and `debug` is a separate explicit opt-in.
 */
export type TelemetryMode = 'no' | 'advanced' | 'debug';

export interface TelemetryModeInput {
  /** Resolved endpoint, or undefined when none was supplied. */
  endpoint: string | undefined;
  debug: boolean;
  disabled: boolean;
}

export function resolveTelemetryMode(input: TelemetryModeInput): TelemetryMode {
  if (input.disabled) return 'no';
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
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
      url.hostname.toLowerCase(),
    );
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error(
      'Telemetry endpoint must use HTTPS (HTTP is allowed only for localhost)',
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
): TelemetryExportConfiguration {
  const resolvedEndpoint = resolveTelemetryEndpoint(endpoint);
  if (resolvedEndpoint === undefined) {
    throw new Error('Telemetry endpoint must not be empty');
  }
  return {
    endpoint: resolvedEndpoint,
    logsUrl: `${resolvedEndpoint}/v1/logs`,
    tracesUrl: `${resolvedEndpoint}/v1/traces`,
    metricsUrl: `${resolvedEndpoint}/v1/metrics`,
    headers: parseHeaders(env[TELEMETRY_HEADERS_ENV]),
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
  if (mode === 'advanced') {
    return {
      mode,
      title: 'Telemetry is enabled',
      lines: [
        `Logs, metrics, and traces are exported to ${endpoint}.`,
        'Chat content, message text, and credentials are excluded.',
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
