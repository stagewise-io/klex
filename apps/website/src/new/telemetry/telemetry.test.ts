import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import main from '../main.ts?raw';
import resources from '../resources/main.ts?raw';
import { createTelemetry } from './telemetry';

const sdk = vi.hoisted(() => ({ init: vi.fn(), construct: vi.fn() }));
vi.mock('posthog-js', () => ({
  PostHog: class {
    constructor() {
      sdk.construct();
    }
    init = sdk.init;
  },
}));

const config = { key: 'phc_testonly', host: 'https://eu.i.posthog.com' };
beforeEach(() => {
  sdk.init.mockReset();
  sdk.construct.mockReset();
  vi.stubGlobal('navigator', { doNotTrack: null });
  vi.stubEnv('VITE_POSTHOG_KEY', '');
  vi.stubEnv('VITE_POSTHOG_HOST', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('website telemetry', () => {
  it('disables missing or invalid configuration without constructing the SDK', async () => {
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
      await createTelemetry(invalid).initialize();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it.each([
    { doNotTrack: '1' },
    { doNotTrack: 'yes' },
    { globalPrivacyControl: true },
  ])('respects browser privacy signals: %o', async (signals) => {
    vi.stubGlobal('navigator', signals);
    await createTelemetry(config).initialize();
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it('uses standard SDK analytics without stripping URLs, attribution, identity, or session properties', async () => {
    vi.stubEnv('VITE_POSTHOG_KEY', config.key);
    vi.stubEnv('VITE_POSTHOG_HOST', config.host);
    const telemetry = createTelemetry();
    await Promise.all([telemetry.initialize(), telemetry.initialize()]);
    expect(sdk.construct).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledExactlyOnceWith(config.key, {
      api_host: config.host,
      persistence: 'localStorage+cookie',
      person_profiles: 'identified_only',
      respect_dnt: true,
      capture_pageview: 'history_change',
      capture_pageleave: true,
      autocapture: true,
      disable_capture_url_hashes: false,
      save_referrer: true,
      save_campaign_params: true,
      disable_session_recording: true,
    });
    const options = sdk.init.mock.calls[0][1];
    for (const removed of [
      'before_send',
      'bootstrap',
      'disable_persistence',
      'mask_all_text',
      'mask_all_element_attributes',
      'advanced_disable_flags',
      'disable_external_dependency_loading',
    ])
      expect(options).not.toHaveProperty(removed);
  });

  it('accepts the EU host with a trailing slash', async () => {
    await createTelemetry({ ...config, host: `${config.host}/` }).initialize();
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it.each(['construct', 'init'] as const)(
    'ignores %s failures without blocking the website or reinitializing',
    async (failure) => {
      const fail = () => {
        throw new Error('blocked');
      };
      if (failure === 'construct') sdk.construct.mockImplementationOnce(fail);
      if (failure === 'init') sdk.init.mockImplementationOnce(fail);
      const telemetry = createTelemetry(config);
      await expect(telemetry.initialize()).resolves.toBeUndefined();
      await telemetry.initialize();
      expect(sdk.construct).toHaveBeenCalledTimes(1);
      expect(sdk.init).toHaveBeenCalledTimes(failure === 'init' ? 1 : 0);
    },
  );

  it('initializes analytics on homepage and resource pages', () => {
    for (const entry of [main, resources]) {
      expect(entry).toContain('createTelemetry');
      expect(entry).toContain('telemetry.initialize();');
    }
  });
});
