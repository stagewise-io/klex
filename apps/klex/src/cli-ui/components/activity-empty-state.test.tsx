import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { ActivityIndicator } from './activity-indicator';
import { EmptyState } from './empty-state';
import { KeyHint } from './key-hint';

describe('ActivityIndicator', () => {
  it('renders a spinner with its activity label', () => {
    const view = render(<ActivityIndicator label="Loading providers..." />);
    expect(view.lastFrame()).toContain('Loading providers...');
  });
});

describe('EmptyState', () => {
  it('renders muted and warning content', () => {
    expect(render(<EmptyState>No data.</EmptyState>).lastFrame()).toContain(
      'No data.',
    );
    expect(
      render(<EmptyState tone="warning">Unavailable.</EmptyState>).lastFrame(),
    ).toContain('Unavailable.');
  });

  it('supports framing and rich key-hint content', () => {
    const frame = render(
      <EmptyState framed>
        Press <KeyHint keyName="a" /> to add one.
      </EmptyState>,
    ).lastFrame();
    expect(frame).toContain('╭');
    expect(frame).toContain('[a]');
  });
});
