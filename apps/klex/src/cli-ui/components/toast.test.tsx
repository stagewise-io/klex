import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { ToastStack } from './toast';

describe('ToastStack', () => {
  it('keeps long notifications within the available width', () => {
    const view = render(
      <Box width={40}>
        <ToastStack
          toasts={[
            {
              id: 1,
              level: 'warning',
              message: `A long model identifier: ${'model-segment-'.repeat(8)}`,
            },
          ]}
          onDismiss={vi.fn()}
        />
      </Box>,
    );

    const lines = (view.lastFrame() ?? '').split('\n');
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(4);
  });
});
