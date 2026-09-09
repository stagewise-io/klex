import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { MenuList } from './menu-list';

describe('MenuList', () => {
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
