import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { TextInputActiveProvider } from '../hooks/use-text-input-active';
import { ConfirmationPanel } from './confirmation-panel';

function renderPanel(onConfirm = vi.fn(), onCancel = vi.fn()) {
  return render(
    <TextInputActiveProvider>
      <ConfirmationPanel
        title="Delete provider?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        <Text>This cannot be undone.</Text>
      </ConfirmationPanel>
    </TextInputActiveProvider>,
  );
}

describe('ConfirmationPanel', () => {
  it('renders consequences and consistent key hints', () => {
    const frame = renderPanel().lastFrame();
    expect(frame).toContain('Delete provider?');
    expect(frame).toContain('This cannot be undone.');
    expect(frame).toContain('[y]');
    expect(frame).toContain('[n]');
    expect(frame).toContain('[Esc]');
  });

  it('routes confirm and both cancellation keys', async () => {
    const onConfirm = vi.fn();
    const onCancelWithN = vi.fn();
    const confirmView = renderPanel(onConfirm, onCancelWithN);
    confirmView.stdin.write('y');
    expect(onConfirm).toHaveBeenCalledOnce();
    confirmView.stdin.write('n');
    expect(onCancelWithN).toHaveBeenCalledOnce();

    const onCancelWithEscape = vi.fn();
    const cancelView = renderPanel(vi.fn(), onCancelWithEscape);
    cancelView.stdin.write('\u001B');
    await vi.waitFor(() => expect(onCancelWithEscape).toHaveBeenCalledOnce());
  });

  it('suppresses duplicate confirmation while the action is pending', async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolvePromise) => {
          resolve = resolvePromise;
        }),
    );
    const view = renderPanel(onConfirm);
    view.stdin.write('y');
    view.stdin.write('y');
    expect(onConfirm).toHaveBeenCalledOnce();
    resolve();
    await Promise.resolve();
  });
});
