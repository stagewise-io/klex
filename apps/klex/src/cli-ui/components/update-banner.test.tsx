import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '@/self-update';

import { UpdateBanner } from './update-banner';

function manager(initial: UpdateState) {
  let state = initial;
  const listeners = new Set<(state: UpdateState) => void>();
  const value = {
    getState: () => state,
    install: vi.fn(async () => undefined),
    subscribe: (listener: (state: UpdateState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState(next: UpdateState) {
      state = next;
      for (const listener of listeners) listener(state);
    },
  };
  return value;
}

describe('UpdateBanner', () => {
  it('shows an available update and starts it only once for repeated input', async () => {
    const updateManager = manager({ status: 'available', version: '1.2.4' });
    const view = render(
      <UpdateBanner activeSessionCount={0} manager={updateManager} />,
    );
    expect(view.lastFrame()).toContain('Klex 1.2.4 is available');
    expect(view.lastFrame()).toContain('[u] Update & restart');
    expect(view.lastFrame()).toContain('[n] Dismiss for now');
    await act(async () => {
      view.stdin.write('u');
      view.stdin.write('u');
    });
    expect(updateManager.install).toHaveBeenCalledOnce();
  });

  it('requires confirmation when active sessions will be interrupted', async () => {
    const updateManager = manager({ status: 'available', version: '1.2.4' });
    const view = render(
      <UpdateBanner activeSessionCount={2} manager={updateManager} />,
    );
    await act(async () => view.stdin.write('u'));
    expect(view.lastFrame()).toContain('2 active sessions will be interrupted');
    expect(updateManager.install).not.toHaveBeenCalled();
    await act(async () => view.stdin.write('u'));
    expect(updateManager.install).toHaveBeenCalledOnce();
  });

  it('dismisses an offer for the current run', async () => {
    const updateManager = manager({ status: 'available', version: '1.2.4' });
    const view = render(
      <UpdateBanner activeSessionCount={0} manager={updateManager} />,
    );
    await act(async () => view.stdin.write('n'));
    expect(view.lastFrame()).not.toContain('1.2.4');
  });

  it('renders progress and supports retry after failure', async () => {
    const updateManager = manager({
      status: 'installing',
      message: 'Installing update',
      version: '1.2.4',
    });
    const view = render(
      <UpdateBanner activeSessionCount={0} manager={updateManager} />,
    );
    expect(view.lastFrame()).toContain('Installing update');
    await act(async () =>
      updateManager.setState({
        status: 'failed',
        message: 'lock busy',
        version: '1.2.4',
      }),
    );
    expect(view.lastFrame()).toContain('Update failed: lock busy');
    expect(view.lastFrame()).toContain('[u] Retry');
    expect(view.lastFrame()).toContain('[n] Dismiss for now');
    await act(async () => view.stdin.write('u'));
    await act(async () =>
      updateManager.setState({
        status: 'installing',
        message: 'Installing update',
        version: '1.2.4',
      }),
    );
    await act(async () =>
      updateManager.setState({
        status: 'failed',
        message: 'still busy',
        version: '1.2.4',
      }),
    );
    await act(async () => view.stdin.write('u'));
    expect(updateManager.install).toHaveBeenCalledTimes(2);
  });

  it('renders restart state without interactive actions', () => {
    const updateManager = manager({ status: 'restarting', version: '1.2.4' });
    const view = render(
      <UpdateBanner activeSessionCount={0} manager={updateManager} />,
    );
    expect(view.lastFrame()).toContain('Restarting');
    expect(view.lastFrame()).not.toContain('[u]');
  });
});
