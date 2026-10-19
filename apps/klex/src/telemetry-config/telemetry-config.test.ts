import { describe, expect, it } from 'vitest';

import {
  createTelemetryExportConfiguration,
  describeTelemetryWarning,
  formatTelemetryWarning,
  isInsecureTelemetryEndpoint,
  parseTelemetryLevel,
  resolveTelemetryEndpoint,
  resolveTelemetryMode,
} from './telemetry-config';

const INTERNAL = 'http://alloy.monitoring.svc:4318';

describe('telemetry configuration', () => {
  it('removes all trailing endpoint slashes before adding signal paths', () => {
    const configuration = createTelemetryExportConfiguration(
      'https://collector.example///',
      {},
    );

    expect(configuration.endpoint).toBe('https://collector.example');
    expect(configuration.logsUrl).toBe('https://collector.example/v1/logs');
    expect(configuration.tracesUrl).toBe('https://collector.example/v1/traces');
    expect(configuration.metricsUrl).toBe(
      'https://collector.example/v1/metrics',
    );
  });

  it('accepts valid headers and rejects invalid names and values', () => {
    expect(
      createTelemetryExportConfiguration('https://collector.example', {
        KLEX_TELEMETRY_HEADERS: '{"Authorization":"Bearer token","x-id":"1"}',
      }).headers,
    ).toEqual({ Authorization: 'Bearer token', 'x-id': '1' });

    expect(() =>
      createTelemetryExportConfiguration('https://collector.example', {
        KLEX_TELEMETRY_HEADERS: '{"bad name":"value"}',
      }),
    ).toThrow(/invalid header name/);
    expect(() =>
      createTelemetryExportConfiguration('https://collector.example', {
        KLEX_TELEMETRY_HEADERS: '{"x-test":"bad\\nvalue"}',
      }),
    ).toThrow(/invalid header value/);
  });

  it('retains endpoint transport validation', () => {
    expect(() => resolveTelemetryEndpoint('http://collector.example')).toThrow(
      /HTTPS/,
    );
    expect(() => resolveTelemetryEndpoint('http://localhost///')).not.toThrow();
  });
});

describe('parseTelemetryLevel', () => {
  it('accepts exact level names and treats blank as unset', () => {
    expect(parseTelemetryLevel('basic')).toBe('basic');
    expect(parseTelemetryLevel(' advanced ')).toBe('advanced');
    expect(parseTelemetryLevel('debug')).toBe('debug');
    expect(parseTelemetryLevel(undefined)).toBeUndefined();
    expect(parseTelemetryLevel('  ')).toBeUndefined();
  });

  it.each(['no', 'BASIC', 'full', 'true'])('rejects %s', (value) => {
    expect(() => parseTelemetryLevel(value)).toThrow('Invalid telemetry level');
  });
});

describe('resolveTelemetryMode', () => {
  const endpoint = 'https://otel.example';

  it('keeps the endpoint-derived defaults', () => {
    expect(
      resolveTelemetryMode({
        endpoint: undefined,
        debug: false,
        disabled: false,
      }),
    ).toBe('no');
    expect(
      resolveTelemetryMode({ endpoint, debug: false, disabled: false }),
    ).toBe('advanced');
    expect(
      resolveTelemetryMode({ endpoint, debug: true, disabled: false }),
    ).toBe('debug');
  });

  it.each(['basic', 'advanced', 'debug'] as const)(
    'selects explicit level %s',
    (level) => {
      expect(
        resolveTelemetryMode({
          endpoint,
          debug: false,
          disabled: false,
          level,
        }),
      ).toBe(level);
    },
  );

  it('accepts the debug flag together with level debug', () => {
    expect(
      resolveTelemetryMode({
        endpoint,
        debug: true,
        disabled: false,
        level: 'debug',
      }),
    ).toBe('debug');
  });

  it.each(['basic', 'advanced'] as const)(
    'rejects the debug flag with level %s',
    (level) => {
      expect(() =>
        resolveTelemetryMode({ endpoint, debug: true, disabled: false, level }),
      ).toThrow('Debug telemetry conflicts with telemetry level');
    },
  );

  it('requires an endpoint for an explicit level', () => {
    expect(() =>
      resolveTelemetryMode({
        endpoint: undefined,
        debug: false,
        disabled: false,
        level: 'basic',
      }),
    ).toThrow('Telemetry level basic requires an endpoint');
  });

  it('lets disable override every other input', () => {
    expect(
      resolveTelemetryMode({
        endpoint: undefined,
        debug: true,
        disabled: true,
        level: 'basic',
      }),
    ).toBe('no');
  });
});

describe('resolveTelemetryEndpoint', () => {
  it('rejects non-loopback HTTP without the insecure opt-in', () => {
    expect(() => resolveTelemetryEndpoint(INTERNAL)).toThrow(
      'Telemetry endpoint must use HTTPS',
    );
  });

  it('accepts non-loopback HTTP with the insecure opt-in', () => {
    expect(
      resolveTelemetryEndpoint(`${INTERNAL}/`, { allowInsecure: true }),
    ).toBe(INTERNAL);
  });

  it('still rejects other schemes and credentials with the opt-in', () => {
    expect(() =>
      resolveTelemetryEndpoint('ftp://alloy:4318', { allowInsecure: true }),
    ).toThrow('Telemetry endpoint must use HTTPS');
    expect(() =>
      resolveTelemetryEndpoint('http://user:pw@alloy:4318', {
        allowInsecure: true,
      }),
    ).toThrow('must not contain credentials');
  });
});

describe('isInsecureTelemetryEndpoint', () => {
  it('flags only non-loopback HTTP', () => {
    expect(isInsecureTelemetryEndpoint(INTERNAL)).toBe(true);
    expect(isInsecureTelemetryEndpoint('http://localhost:4318')).toBe(false);
    expect(isInsecureTelemetryEndpoint('http://[::1]:4318')).toBe(false);
    expect(isInsecureTelemetryEndpoint('https://otel.example')).toBe(false);
  });
});

describe('createTelemetryExportConfiguration', () => {
  it('builds signal URLs for an allowed insecure endpoint', () => {
    expect(
      createTelemetryExportConfiguration(INTERNAL, {}, { allowInsecure: true }),
    ).toEqual({
      endpoint: INTERNAL,
      logsUrl: `${INTERNAL}/v1/logs`,
      tracesUrl: `${INTERNAL}/v1/traces`,
      metricsUrl: `${INTERNAL}/v1/metrics`,
      headers: {},
    });
  });

  it('refuses to send headers over non-loopback HTTP', () => {
    expect(() =>
      createTelemetryExportConfiguration(
        INTERNAL,
        { KLEX_TELEMETRY_HEADERS: '{"Authorization":"Basic x"}' },
        { allowInsecure: true },
      ),
    ).toThrow('must not be sent over plain HTTP');
  });

  it('allows headers over loopback HTTP', () => {
    expect(
      createTelemetryExportConfiguration('http://localhost:4318', {
        KLEX_TELEMETRY_HEADERS: '{"x-test":"1"}',
      }).headers,
    ).toEqual({ 'x-test': '1' });
  });
});

describe('describeTelemetryWarning', () => {
  it('describes basic as metrics and warnings without traces', () => {
    const warning = describeTelemetryWarning('basic', 'https://otel.example');
    expect(warning?.title).toBe('Telemetry is enabled (basic)');
    expect(warning?.lines.join(' ')).toContain('Metrics and warning logs');
    expect(warning?.lines.join(' ')).toContain('Traces');
    expect(warning?.lines.join(' ')).not.toContain('unencrypted');
  });

  it.each(['basic', 'advanced', 'debug'] as const)(
    'adds an unencrypted-transport line for insecure %s',
    (mode) => {
      const warning = describeTelemetryWarning(mode, INTERNAL);
      expect(warning?.lines).toContain(
        'Telemetry is sent unencrypted over HTTP.',
      );
      expect(formatTelemetryWarning(warning!)).toContain('unencrypted');
    },
  );

  it('returns nothing when telemetry is off', () => {
    expect(describeTelemetryWarning('no', INTERNAL)).toBeUndefined();
    expect(describeTelemetryWarning('basic', undefined)).toBeUndefined();
  });
});
