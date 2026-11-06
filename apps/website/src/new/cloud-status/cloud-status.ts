import { type Message, t } from '@/i18n';

type Summary = {
  ongoing_incidents: { current_worst_impact?: string }[];
  in_progress_maintenances: unknown[];
  scheduled_maintenances: unknown[];
};

export function describeCloudStatus(value: unknown) {
  const summary = value as Summary | null;
  if (
    !summary ||
    !Array.isArray(summary.ongoing_incidents) ||
    !Array.isArray(summary.in_progress_maintenances) ||
    !Array.isArray(summary.scheduled_maintenances)
  )
    throw new Error('Invalid cloud status');
  if (
    summary.ongoing_incidents.some(
      (incident) => incident?.current_worst_impact === 'full_outage',
    )
  )
    return { state: 'outage', label: 'Klex Cloud: service outage' };
  if (
    summary.ongoing_incidents.some(
      (incident) => incident?.current_worst_impact === 'partial_outage',
    )
  )
    return { state: 'outage', label: 'Klex Cloud: partial outage' };
  if (
    summary.ongoing_incidents.some(
      (incident) => incident?.current_worst_impact === 'degraded_performance',
    )
  )
    return { state: 'degraded', label: 'Klex Cloud: degraded performance' };
  if (summary.ongoing_incidents.length)
    return { state: 'degraded', label: 'Klex Cloud: incident ongoing' };
  if (summary.in_progress_maintenances.length)
    return {
      state: 'maintenance',
      label: 'Klex Cloud: maintenance in progress',
    };
  if (summary.scheduled_maintenances.length)
    return { state: 'maintenance', label: 'Klex Cloud: maintenance scheduled' };
  return { state: 'operational', label: 'Klex Cloud: all systems operational' };
}

class CloudStatus {
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;

  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  start() {
    if (this.timer) return;
    void this.update();
    this.timer = setInterval(() => {
      if (!document.hidden) void this.update();
    }, 60000);
  }

  private async update() {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch('/api/cloud-status', {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Cloud status unavailable');
      const status = describeCloudStatus(await response.json());
      if (controller.signal.aborted) return;
      this.host.dataset.state = status.state;
      const label = this.host.querySelector('[data-cloud-status-label]');
      if (label) label.textContent = t(status.label as Message);
    } catch {
      if (!controller.signal.aborted || this.timer) {
        this.host.dataset.state = 'unknown';
        const label = this.host.querySelector('[data-cloud-status-label]');
        if (label) label.textContent = t('Klex Cloud status');
      }
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
}

export function mountCloudStatus() {
  const host = document.querySelector<HTMLElement>('[data-cloud-status]');
  if (!host) return () => {};
  const status = new CloudStatus(host);
  status.start();
  return () => status.close();
}
