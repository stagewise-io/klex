type TelemetryConfig = { key?: string; host?: string };

export function privacySignalEnabled(): boolean {
  const signals = navigator as Navigator & { globalPrivacyControl?: boolean };
  return (
    navigator.doNotTrack === '1' ||
    navigator.doNotTrack === 'yes' ||
    signals.globalPrivacyControl === true
  );
}

// Deliberately use only the capture API: no SDK, remote configuration, DOM
// collection, recording, cookies, fingerprinting, or persistent identity.
export function createTelemetry({ key, host }: TelemetryConfig) {
  if (!key?.trim() || !host?.trim() || privacySignalEnabled()) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(host);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      return null;
    endpoint.pathname = '/i/v0/e/';
  } catch {
    return null;
  }

  let sent = false;
  let pending: AbortController | undefined;
  return {
    allow() {
      if (sent || privacySignalEnabled()) return;
      sent = true;
      pending = new AbortController();
      // A fresh ID for each document, never stored or reused on another visit.
      const payload = {
        api_key: key.trim(),
        event: '$pageview',
        distinct_id: crypto.randomUUID(),
        properties: {
          // The website currently has one landing page. Do not copy arbitrary
          // URL paths, query strings, fragments, titles, or referrers into events.
          $pathname: '/',
          $ip: null,
          $geoip_disable: true,
          $process_person_profile: false,
          $is_identified: false,
        },
      };
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: pending.signal,
      }).catch(() => {
        // Analytics failures must never affect the website. No queued retries.
      });
    },
    decline() {
      pending?.abort();
    },
  };
}

export function initializeTelemetry(container: HTMLElement) {
  const telemetry = createTelemetry({
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST,
  });
  if (!telemetry) return;

  container.innerHTML = `
    <section class="analytics-consent" aria-labelledby="analytics-heading">
      <h2 id="analytics-heading">Help us count website visits</h2>
      <p>Allow one anonymous page view to be sent to PostHog? No cookies, recording, or tracking across visits. Your choice applies to this page load only.</p>
      <div class="analytics-actions">
        <button type="button" data-analytics="allow">Allow analytics</button>
        <button type="button" data-analytics="decline">No thanks</button>
      </div>
      <p role="status" data-analytics-status>Analytics are off until you allow them.</p>
    </section>
  `;
  const allow = container.querySelector<HTMLButtonElement>(
    '[data-analytics="allow"]',
  );
  const decline = container.querySelector<HTMLButtonElement>(
    '[data-analytics="decline"]',
  );
  const status = container.querySelector<HTMLElement>(
    '[data-analytics-status]',
  );
  if (!allow || !decline || !status) return;
  allow.addEventListener('click', () => {
    telemetry.allow();
    status.textContent = privacySignalEnabled()
      ? 'Analytics are off because of your browser privacy preference.'
      : 'One page view allowed. No further activity is collected.';
    decline.textContent = 'Turn off analytics';
  });
  decline.addEventListener('click', () => {
    telemetry.decline();
    status.textContent =
      'Analytics are off. A page view already sent cannot be recalled.';
    decline.textContent = 'No thanks';
  });
}
