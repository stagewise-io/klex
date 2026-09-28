import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelemetry } from './telemetry';

const config = { key: 'public-test-token', host: 'https://eu.i.posthog.com' };

afterEach(() => vi.unstubAllGlobals());

function setup(signals = {}) {
  vi.stubGlobal('navigator', { doNotTrack: null, ...signals });
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('website telemetry privacy boundary', () => {
  it('does nothing without both a key and a valid HTTPS ingestion origin', () => {
    const fetch = setup();
    for (const invalid of [
      {},
      { ...config, key: '' },
      { ...config, key: ' ' },
      { key: config.key },
      ...[
        'not-a-url',
        'http://example.com',
        'https://user:pass@example.com',
        'https://example.com/?secret=x',
        'https://example.com/#x',
        'https://example.com/path',
      ].map((host) => ({ ...config, host })),
    ])
      expect(createTelemetry(invalid)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { doNotTrack: '1' },
    { doNotTrack: 'yes' },
    { globalPrivacyControl: true },
  ])('respects browser privacy signals: %o', (signals) => {
    const fetch = setup(signals);
    expect(createTelemetry(config)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires explicit consent and sends only the allowed payload once', () => {
    const fetch = setup();
    const telemetry = createTelemetry(config);
    expect(fetch).not.toHaveBeenCalled();
    telemetry?.decline();
    expect(fetch).not.toHaveBeenCalled();
    telemetry?.allow();
    telemetry?.allow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://eu.i.posthog.com/i/v0/e/');
    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    expect(JSON.parse(request.body)).toEqual({
      api_key: config.key,
      event: '$pageview',
      distinct_id: expect.any(String),
      properties: {
        $pathname: '/',
        $ip: null,
        $geoip_disable: true,
        $process_person_profile: false,
        $is_identified: false,
      },
    });
    telemetry?.decline();
    expect(request.signal.aborted).toBe(true);
    telemetry?.allow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('checks privacy signals again at consent time', () => {
    const fetch = setup();
    const telemetry = createTelemetry(config);
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    telemetry?.allow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a new identity for each document and tolerates network failures', async () => {
    const fetch = setup();
    fetch.mockRejectedValue(new Error('offline'));
    createTelemetry(config)?.allow();
    createTelemetry(config)?.allow();
    const ids = fetch.mock.calls.map(
      ([, request]) => JSON.parse(request.body).distinct_id,
    );
    expect(ids[0]).not.toBe(ids[1]);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
