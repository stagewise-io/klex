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
      const { PostHog } = await import('posthog-js');
      const posthog = new PostHog();
      posthog.init(key, {
        api_host: 'https://eu.i.posthog.com',
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
    } catch {
      // Analytics failures must not prevent the website from initializing.
    }
  }
}

export function createTelemetry({
  key = import.meta.env.VITE_POSTHOG_KEY,
  host = import.meta.env.VITE_POSTHOG_HOST,
}: TelemetryConfig = {}): Telemetry {
  return new TelemetryModule({ key, host });
}
