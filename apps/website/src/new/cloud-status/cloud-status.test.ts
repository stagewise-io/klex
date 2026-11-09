import { describe, expect, it } from 'vitest';

import { describeCloudStatus } from './cloud-status';

const summary = (impact?: string) => ({
  ongoing_incidents: impact ? [{ current_worst_impact: impact }] : [],
  in_progress_maintenances: [],
  scheduled_maintenances: [],
});

describe('cloud status labels', () => {
  it('reports operational only for a valid empty summary', () =>
    expect(describeCloudStatus(summary()).state).toBe('operational'));
  it.each(['full_outage', 'partial_outage'])('reports %s', (impact) =>
    expect(describeCloudStatus(summary(impact)).state).toBe('outage'),
  );
  it('keeps monitoring incidents visible even after components recover', () =>
    expect(describeCloudStatus(summary('operational')).label).toContain(
      'incident ongoing',
    ));
  it('reports degraded performance', () =>
    expect(describeCloudStatus(summary('degraded_performance')).state).toBe(
      'degraded',
    ));
  it('reports maintenance separately', () =>
    expect(
      describeCloudStatus({ ...summary(), in_progress_maintenances: [{}] })
        .label,
    ).toContain('maintenance in progress'));
  it('reports scheduled maintenance', () =>
    expect(
      describeCloudStatus({ ...summary(), scheduled_maintenances: [{}] }).label,
    ).toContain('maintenance scheduled'));
  it('prioritizes incidents over maintenance', () =>
    expect(
      describeCloudStatus({
        ...summary('full_outage'),
        in_progress_maintenances: [{}],
      }).state,
    ).toBe('outage'));
  it.each([null, {}, { ongoing_incidents: [] }])(
    'rejects invalid summaries',
    (value) => expect(() => describeCloudStatus(value)).toThrow(),
  );
});
