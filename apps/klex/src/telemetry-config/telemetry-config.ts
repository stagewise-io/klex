export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.klex.bot';
export const TELEMETRY_ENDPOINT_ENV = 'KLEX_TELEMETRY_ENDPOINT';
export const TELEMETRY_HEADERS_ENV = 'KLEX_TELEMETRY_HEADERS';
export interface TelemetryExportConfiguration {
  readonly endpoint: string;
  readonly logsUrl: string;
  readonly tracesUrl: string;
  readonly metricsUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function resolveTelemetryEndpoint(value?: string): string {
  const candidate = value?.trim() || DEFAULT_TELEMETRY_ENDPOINT;
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
  return url.toString().replace(/\/$/, '');
}

export function createTelemetryExportConfiguration(
  endpoint: string | undefined,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): TelemetryExportConfiguration {
  const resolvedEndpoint = resolveTelemetryEndpoint(
    endpoint ?? env[TELEMETRY_ENDPOINT_ENV],
  );
  return {
    endpoint: resolvedEndpoint,
    logsUrl: `${resolvedEndpoint}/v1/logs`,
    tracesUrl: `${resolvedEndpoint}/v1/traces`,
    metricsUrl: `${resolvedEndpoint}/v1/metrics`,
    headers: parseHeaders(env[TELEMETRY_HEADERS_ENV]),
  };
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
      if (typeof item !== 'string') {
        throw new Error(`${TELEMETRY_HEADERS_ENV} values must be strings`);
      }
      return [key, item];
    }),
  );
}
