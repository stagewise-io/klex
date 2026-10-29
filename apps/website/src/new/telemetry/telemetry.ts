import type { CaptureResult } from 'posthog-js';

export interface TelemetryConfig {
  key?: string;
  host?: string;
}

export interface Telemetry {
  initialize(): Promise<void>;
}

class TelemetryModule implements Telemetry {
  private attempted = false;
  private readonly config: TelemetryConfig;

  constructor(config: TelemetryConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.attempted) return;
    try {
      const { key, host } = this.config;
      const signals = navigator as Navigator & {
        globalPrivacyControl?: boolean;
      };
      if (
        navigator.doNotTrack === '1' ||
        navigator.doNotTrack === 'yes' ||
        signals.globalPrivacyControl === true ||
        !key ||
        !/^phc_[a-zA-Z0-9]+$/.test(key) ||
        (host !== 'https://eu.i.posthog.com' &&
          host !== 'https://eu.i.posthog.com/')
      )
        return;

      this.attempted = true;
      // Load the SDK only after configuration and browser privacy checks pass.
      const distinctId = crypto.randomUUID();
      const { PostHog } = await import('posthog-js');
      const posthog = new PostHog();
      posthog.init(key, {
        api_host: 'https://eu.i.posthog.com',
        persistence: 'memory',
        disable_persistence: true,
        bootstrap: { distinctID: distinctId, isIdentifiedID: false },
        person_profiles: 'never',
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
        before_send: (event) => this.sanitizeEvent(event, key, distinctId),
      });
    } catch {
      // Unavailable browser APIs must not prevent the website from initializing.
    }
  }

  private sanitizeEvent(
    event: CaptureResult,
    key: string,
    distinctId: string,
  ): CaptureResult | null {
    // Fail closed: SDK upgrades cannot silently add new event types or properties.
    if (event.event !== '$pageview' && event.event !== '$autocapture')
      return null;
    if (
      event.event === '$autocapture' &&
      event.properties.$event_type !== 'click'
    )
      return null;

    const properties: CaptureResult['properties'] = {
      token: key,
      distinct_id: distinctId,
      $pathname: '/',
      $ip: null,
      $geoip_disable: true,
      $process_person_profile: false,
      $is_identified: false,
    };
    if (event.event === '$autocapture') {
      properties.$event_type = 'click';
      // Keep only structural selectors, never text, attributes, or link URLs.
      properties.$elements = Array.isArray(event.properties.$elements)
        ? event.properties.$elements.map(
            (element: Record<string, unknown>) => ({
              tag_name: element.tag_name,
              nth_child: element.nth_child,
              nth_of_type: element.nth_of_type,
            }),
          )
        : [];
    }
    return {
      uuid: event.uuid,
      event: event.event,
      timestamp: event.timestamp,
      properties,
    };
  }
}

export function createTelemetry({
  key = import.meta.env.VITE_POSTHOG_KEY,
  host = import.meta.env.VITE_POSTHOG_HOST,
}: TelemetryConfig = {}): Telemetry {
  return new TelemetryModule({ key, host });
}
