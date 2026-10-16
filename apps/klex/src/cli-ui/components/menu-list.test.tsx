import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MenuList } from './menu-list';

afterEach(cleanup);

describe('MenuList', () => {
  it('truncates multiline labels to one row and prevents disabled selection', async () => {
    const onSelect = vi.fn();
    const view = render(
      <Box width={32}>
        <MenuList
          items={[
            {
              label: `Unavailable\n${'reason '.repeat(30)}END`,
              value: 'disabled',
              disabled: true,
            },
            { label: 'Available', value: 'available' },
          ]}
          onSelect={onSelect}
        />
      </Box>,
    );
    expect(view.lastFrame()).toContain('Unavailable reason');
    expect(view.lastFrame()).not.toContain('END');
    expect(
      view
        .lastFrame()
        ?.split('\n')
        .filter((line) => line.includes('reason')),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('1');
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSelect).not.toHaveBeenCalled();
    view.stdin.write('2');
    await vi.waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith({
        label: 'Available',
        value: 'available',
      }),
    );
  });
  it('renders standard framing and forwards selection', async () => {
    const onSelect = vi.fn();
    const view = render(
      <MenuList
        items={[
          { label: 'First', value: 'first' },
          { label: 'Second', value: 'second' },
        ]}
        onSelect={onSelect}
      />,
    );

    expect(view.lastFrame()).toContain('╭');
    expect(view.lastFrame()).toContain('First');
    expect(view.lastFrame()).toContain('Second');

    view.stdin.write('\u001B[B');
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSelect).toHaveBeenCalledWith({
      label: 'Second',
      value: 'second',
    });
  });

  it('shows a scrollbar when the item count exceeds the visible limit', () => {
    const view = render(
      <MenuList
        items={Array.from({ length: 4 }, (_, index) => ({
          label: `Item ${index + 1}`,
          value: index,
        }))}
        visibleCount={2}
      />,
    );

    expect(view.lastFrame()).toContain('█');
    expect(view.lastFrame()).toContain('│');
    expect(view.lastFrame()).not.toContain('Item 3');
  });
});
