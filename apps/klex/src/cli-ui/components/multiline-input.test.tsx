import { render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MultilineInput } from './multiline-input';

const views: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
});

describe('MultilineInput', () => {
  it('replaces the editing buffer when the parent replaces its value', async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const view = render(
      <MultilineInput
        value="Old draft"
        onChange={onChange}
        onSubmit={onSubmit}
      />,
    );
    views.push(view);
    view.rerender(
      <MultilineInput value="New" onChange={onChange} onSubmit={onSubmit} />,
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('New'));
    view.stdin.write('!');
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('New!'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('New!'));
  });

  it('preserves multiline pasted input and edits Unicode code points without submitting', async () => {
    const onSubmit = vi.fn();
    function Composer() {
      const [value, setValue] = useState('');
      return (
        <MultilineInput value={value} onChange={setValue} onSubmit={onSubmit} />
      );
    }
    const view = render(<Composer />);
    views.push(view);
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Type instructions'),
    );
    view.stdin.write('First\nSecond🦊');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Second🦊'));
    expect(onSubmit).not.toHaveBeenCalled();
    view.stdin.write('\u007f');
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('🦊'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('First\nSecond'),
    );
  });
});
