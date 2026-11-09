class CloudStatus {
  constructor(fetcher) {
    this.fetcher = fetcher;
    this.cached = undefined;
    this.pending = undefined;
  }

  async response() {
    if (this.cached && Date.now() - this.cached.at < 30000)
      return this.cached.result;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  async load() {
    try {
      const response = await this.fetcher(
        'https://status.klex.bot/api/v1/summary',
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        },
      );
      if (!response.ok) throw new Error('Status provider unavailable');
      const summary = await response.json();
      if (
        !summary ||
        ![
          'ongoing_incidents',
          'in_progress_maintenances',
          'scheduled_maintenances',
        ].every((key) => Array.isArray(summary[key]))
      )
        throw new Error('Invalid status summary');
      const result = {
        status: 200,
        body: JSON.stringify({
          ongoing_incidents: summary.ongoing_incidents.map((incident) => ({
            current_worst_impact: incident.current_worst_impact,
          })),
          in_progress_maintenances: summary.in_progress_maintenances.map(
            () => ({}),
          ),
          scheduled_maintenances: summary.scheduled_maintenances.map(
            () => ({}),
          ),
        }),
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=30',
          'CDN-Cache-Control': 'public, max-age=30',
          'X-Content-Type-Options': 'nosniff',
        },
      };
      this.cached = { at: Date.now(), result };
      return result;
    } catch {
      return {
        status: 503,
        headers: {
          'Content-Type': 'application/problem+json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          code: 'STATUS_UNAVAILABLE',
          detail:
            'The cloud status provider could not be reached or returned an invalid summary.',
          resolution:
            'Retry shortly or open https://status.klex.bot/ for the public status page.',
          links: [
            { href: 'https://status.klex.bot/', label: 'Klex Cloud status' },
          ],
        }),
      };
    }
  }
}

export const createCloudStatus = (fetcher = fetch) => new CloudStatus(fetcher);
