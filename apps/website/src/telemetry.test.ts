import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import main from './main.ts?raw';

const config = { key: 'phc_testonly', host: 'https://eu.i.posthog.com' };
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_POSTHOG_KEY', '');
  vi.stubEnv('VITE_POSTHOG_HOST', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(signals = {}) {
  vi.stubGlobal('navigator', { doNotTrack: null, ...signals });
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('website telemetry privacy boundary', () => {
  it('disables missing or invalid configuration', async () => {
    const fetch = setup();
    const { initializeTelemetry } = await import('./telemetry');
    for (const invalid of [
      {},
      ...['', ' ', 'secret', 'phx_personal', 'phc_', 'phc_has space'].map(
        (key) => ({ ...config, key }),
      ),
      { key: config.key },
      ...[
        '',
        'not-a-url',
        'http://eu.i.posthog.com',
        'https://us.i.posthog.com',
        'https://example.com',
        'https://user:pass@eu.i.posthog.com',
        'https://eu.i.posthog.com/?secret=x',
        'https://eu.i.posthog.com/#x',
        'https://eu.i.posthog.com/path',
        'https://eu.i.posthog.com.evil.test',
      ].map((host) => ({ ...config, host })),
    ])
      initializeTelemetry(invalid);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { doNotTrack: '1' },
    { doNotTrack: 'yes' },
    { globalPrivacyControl: true },
  ])('suppresses capture for privacy signals: %o', async (signals) => {
    const fetch = setup(signals);
    const { initializeTelemetry } = await import('./telemetry');
    initializeTelemetry(config);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('automatically sends only the allowlisted payload once, without browser data access', async () => {
    const fetch = setup();
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error('Browser data must not be accessed');
        },
        set() {
          throw new Error('Browser data must not be written');
        },
      },
    );
    for (const name of [
      'document',
      'localStorage',
      'sessionStorage',
      'location',
    ])
      vi.stubGlobal(name, forbidden);
    vi.stubEnv('VITE_POSTHOG_KEY', config.key);
    vi.stubEnv('VITE_POSTHOG_HOST', config.host);
    const { initializeTelemetry } = await import('./telemetry');
    initializeTelemetry();
    initializeTelemetry();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/');
    expect(request).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(JSON.parse(request.body)).toEqual({
      api_key: config.key,
      event: '$pageview',
      distinct_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      properties: {
        $pathname: '/',
        $ip: null,
        $geoip_disable: true,
        $process_person_profile: false,
        $is_identified: false,
      },
    });
  });

  it('uses a fresh ID for a new document', async () => {
    const fetch = setup();
    (await import('./telemetry')).initializeTelemetry(config);
    vi.resetModules(); // A new document loads a new module instance.
    (await import('./telemetry')).initializeTelemetry(config);
    const ids = fetch.mock.calls.map(
      ([, request]) => JSON.parse(request.body).distinct_id,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each(['reject', 'throw', 'uuid'] as const)(
    'ignores %s failures without retries',
    async (failure) => {
      const fetch = setup();
      if (failure === 'reject') fetch.mockRejectedValue(new Error('offline'));
      if (failure === 'throw')
        fetch.mockImplementation(() => {
          throw new Error('blocked');
        });
      if (failure === 'uuid') vi.stubGlobal('crypto', {});
      const { initializeTelemetry } = await import('./telemetry');
      expect(() => initializeTelemetry(config)).not.toThrow();
      await Promise.resolve();
      initializeTelemetry(config);
      expect(fetch).toHaveBeenCalledTimes(failure === 'uuid' ? 0 : 1);
    },
  );

  it('mounts no analytics UI in the landing page', () => {
    expect(main).toContain('initializeTelemetry();');
    expect(main).not.toMatch(
      /analytics-consent|telemetry\.css|Allow analytics|No thanks/,
    );
  });
});
