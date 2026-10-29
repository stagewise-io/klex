import type { CaptureResult, PostHogConfig } from 'posthog-js';
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
  vi.stubEnv('VITE_POSTHOG_KEY', '');
  vi.stubEnv('VITE_POSTHOG_HOST', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(signals = {}) {
  vi.stubGlobal('navigator', { doNotTrack: null, ...signals });
  return sdk.init;
}

describe('website telemetry privacy boundary', () => {
  it('disables missing or invalid configuration without constructing the SDK', async () => {
    const init = setup();
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
    expect(init).not.toHaveBeenCalled();
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it.each([
    { doNotTrack: '1' },
    { doNotTrack: 'yes' },
    { globalPrivacyControl: true },
  ])('suppresses capture for privacy signals: %o', async (signals) => {
    const init = setup(signals);
    await createTelemetry(config).initialize();
    expect(init).not.toHaveBeenCalled();
    expect(sdk.construct).not.toHaveBeenCalled();
  });

  it('uses the existing build variables and initializes only once, including concurrent calls', async () => {
    const init = setup();
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
    const telemetry = createTelemetry();
    await Promise.all([telemetry.initialize(), telemetry.initialize()]);
    expect(init).toHaveBeenCalledTimes(1);
    const [key, options] = init.mock.calls[0];
    expect(key).toBe(config.key);
    expect(options).toMatchObject({
      api_host: config.host,
      persistence: 'memory',
      disable_persistence: true,
      person_profiles: 'never',
      bootstrap: {
        distinctID: expect.stringMatching(/^[0-9a-f-]{36}$/),
        isIdentifiedID: false,
      },
      respect_dnt: true,
      capture_pageview: true,
      capture_pageleave: false,
      autocapture: {
        dom_event_allowlist: ['click'],
        css_selector_allowlist: ['a', 'button', '[role="button"]', 'summary'],
        css_selector_ignorelist: [
          '.ph-no-autocapture',
          '[data-ph-no-autocapture]',
          'input',
          'textarea',
          'select',
          '[contenteditable]',
        ],
        capture_copied_text: false,
      },
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_capture_url_hashes: true,
      save_referrer: false,
      save_campaign_params: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_session_recording: true,
      enable_recording_console_log: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      remote_config_refresh_interval_ms: 0,
      before_send: expect.any(Function),
    });
  });

  it('accepts the original EU host with a trailing slash', async () => {
    const init = setup();
    await createTelemetry({ ...config, host: `${config.host}/` }).initialize();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh ID for each document-owned instance', async () => {
    const init = setup();
    await createTelemetry(config).initialize();
    await createTelemetry(config).initialize();
    const ids = init.mock.calls.map(
      ([, options]) => options.bootstrap.distinctID,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each(['construct', 'init', 'uuid'] as const)(
    'ignores %s failures without blocking the website or reinitializing',
    async (failure) => {
      const init = setup();
      const fail = () => {
        throw new Error('blocked');
      };
      if (failure === 'construct') sdk.construct.mockImplementationOnce(fail);
      if (failure === 'init') init.mockImplementationOnce(fail);
      if (failure === 'uuid') vi.stubGlobal('crypto', {});
      const telemetry = createTelemetry(config);
      await expect(telemetry.initialize()).resolves.toBeUndefined();
      await telemetry.initialize();
      expect(init).toHaveBeenCalledTimes(failure === 'init' ? 1 : 0);
    },
  );

  it('strips browser context, person updates, session IDs, text, attributes, and link URLs before sending', async () => {
    const init = setup();
    await createTelemetry(config).initialize();
    const options: Partial<PostHogConfig> = init.mock.calls[0][1];
    const sanitize = options.before_send;
    if (typeof sanitize !== 'function')
      throw new Error('Missing event sanitizer');
    const properties = {
      token: 'untrusted',
      distinct_id: 'old-user-id',
      $session_id: 'session',
      $window_id: 'window',
      $device_id: 'device',
      $current_url: 'https://example.com/?email=private@example.com#secret',
      $referrer: 'https://example.com/private',
      $title: 'Private title',
      utm_source: 'private-campaign',
      $browser: 'Browser',
      $event_type: 'click',
      $el_text: 'Private text',
      $elements_chain: 'button:attr__data-email="private@example.com"',
      $elements: [
        {
          tag_name: 'button',
          nth_child: 2,
          nth_of_type: 1,
          $el_text: 'Private text',
          attr__href: 'https://example.com/?secret=x',
          attr__value: 'private input',
          classes: ['private-class'],
        },
      ],
      $set: { email: 'private@example.com' },
      unexpected: 'future SDK property',
    };
    const base: CaptureResult = {
      uuid: crypto.randomUUID(),
      event: '$pageview',
      timestamp: new Date(),
      properties,
      $set: { email: 'private@example.com' },
      $set_once: { name: 'Private name' },
      $unset: ['private'],
    };
    const expectedProperties = {
      token: config.key,
      distinct_id: options.bootstrap?.distinctID,
      $pathname: '/',
      $ip: null,
      $geoip_disable: true,
      $process_person_profile: false,
      $is_identified: false,
    };
    expect(sanitize(base)).toEqual({
      uuid: base.uuid,
      event: '$pageview',
      timestamp: base.timestamp,
      properties: expectedProperties,
    });
    expect(sanitize({ ...base, event: '$autocapture' })).toEqual({
      uuid: base.uuid,
      event: '$autocapture',
      timestamp: base.timestamp,
      properties: {
        ...expectedProperties,
        $event_type: 'click',
        $elements: [{ tag_name: 'button', nth_child: 2, nth_of_type: 1 }],
      },
    });
    for (const event of [
      '$pageleave',
      '$snapshot',
      '$identify',
      '$exception',
      'heartbeat',
      '$rageclick',
      '$web_vitals',
      'new-sdk-event',
    ])
      expect(sanitize({ ...base, event })).toBeNull();
    for (const $event_type of ['change', 'submit', 'copy', undefined])
      expect(
        sanitize({
          ...base,
          event: '$autocapture',
          properties: { ...properties, $event_type },
        }),
      ).toBeNull();
  });

  it('wires telemetry into the current homepage without tracking resource pages or mounting analytics UI', () => {
    expect(main).toContain("import { createTelemetry } from './telemetry';");
    expect(main).toContain('const telemetry = createTelemetry();');
    expect(main).toContain('telemetry.initialize();');
    expect(resources).not.toMatch(/createTelemetry|telemetry/);
    expect(main).not.toMatch(
      /analytics-consent|telemetry\.css|Allow analytics|No thanks/,
    );
  });
});
