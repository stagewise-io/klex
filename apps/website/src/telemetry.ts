type TelemetryConfig = { key?: string; host?: string };

// Module state lasts only for this document; nothing is persisted across visits.
let attempted = false;

export function initializeTelemetry({
  key = import.meta.env.VITE_POSTHOG_KEY,
  host = import.meta.env.VITE_POSTHOG_HOST,
}: TelemetryConfig = {}): void {
  if (attempted) return;
  try {
    const signals = navigator as Navigator & { globalPrivacyControl?: boolean };
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

    attempted = true;
    // Direct capture only: no SDK or collection from the DOM, URL, or storage.
    const payload = {
      api_key: key,
      event: '$pageview',
      distinct_id: crypto.randomUUID(),
      properties: {
        $pathname: '/', // Fixed landing-page label, never the browser URL.
        $ip: null,
        $geoip_disable: true,
        $process_person_profile: false,
        $is_identified: false,
      },
    };
    void fetch('https://eu.i.posthog.com/i/v0/e/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
    }).catch(() => {
      // Best-effort measurement; never retry or interrupt the website.
    });
  } catch {
    // Unavailable browser APIs must not prevent the website from initializing.
  }
}
