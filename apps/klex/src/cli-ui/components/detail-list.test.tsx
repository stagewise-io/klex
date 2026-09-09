import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { DetailList, DetailRow } from './detail-list';
import { StatusBadge } from './status-badge';

describe('DetailList', () => {
  it('aligns labels using the default width', () => {
    const frame = render(
      <DetailList>
        <DetailRow label="Name">Klex</DetailRow>
        <DetailRow label="Status">Ready</DetailRow>
      </DetailList>,
    ).lastFrame();
    expect(frame).toContain('Name            Klex');
    expect(frame).toContain('Status          Ready');
  });

  it('supports custom label widths and nested values', () => {
    const frame = render(
      <DetailList labelWidth={10}>
        <DetailRow label="State">
          <StatusBadge status="ok" label="connected" />
        </DetailRow>
      </DetailList>,
    ).lastFrame();
    expect(frame).toContain('State     connected');
  });
});
