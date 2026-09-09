import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { InsetPanel } from './inset-panel';

describe('InsetPanel', () => {
  it('renders standard rounded framing', () => {
    const frame = render(
      <InsetPanel>
        <Text>Details</Text>
      </InsetPanel>,
    ).lastFrame();
    expect(frame).toContain('╭');
    expect(frame).toContain('Details');
    expect(frame).toContain('╯');
  });

  it.each(['active', 'error'] as const)('renders the %s tone', (tone) => {
    const frame = render(
      <InsetPanel tone={tone} height={4} overflow="hidden">
        <Text>{tone}</Text>
      </InsetPanel>,
    ).lastFrame();
    expect(frame).toContain(tone);
  });
});
