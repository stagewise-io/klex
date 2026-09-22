import { describe, expect, it } from 'vitest';

import {
  createTelemetryExportConfiguration,
  resolveTelemetryEndpoint,
} from './telemetry-config';

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
