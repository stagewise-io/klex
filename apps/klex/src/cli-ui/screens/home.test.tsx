import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { AdminApiClient } from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { ToastContext } from '../hooks/use-toast';
import { HomeScreen } from './home';

vi.mock('../hooks/use-terminal-size', () => ({
  useTerminalSize: () => ({ width: 80, height: 40 }),
}));

describe('HomeScreen enrollment handoff', () => {
  it.each([false, true])(
    'shows the banner only after enrollment in this launch: %s',
    async (cloudEnrollmentCompleted) => {
      const apiClient = {
        getMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
      } as unknown as AdminApiClient;
      const view = render(
        <ScreenMetaProvider>
          <ToastContext.Provider
            value={{ toasts: [], pushToast: vi.fn(), dismissToast: vi.fn() }}
          >
            <HomeScreen
              apiClient={apiClient}
              sessions={[]}
              cloud={null}
              cloudEnrollmentCompleted={cloudEnrollmentCompleted}
              dangerousLocalAdminApiPort={undefined}
              onRefreshGlobal={vi.fn()}
              onOpenSettings={vi.fn()}
              onOpenUsage={vi.fn()}
            />
          </ToastContext.Provider>
        </ScreenMetaProvider>,
      );
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('Active Sessions'),
      );
      const frame = (view.lastFrame() ?? '')
        .replace(/[│\n]/g, ' ')
        .replace(/\s+/g, ' ');
      if (cloudEnrollmentCompleted) {
        expect(frame).toContain('Your bot is alive!');
        expect(frame).toContain(
          'Head back to Klex Cloud to finish setting up your bot.',
        );
        expect(frame).toContain(
          'Note: This bot runs on this computer. Closing this window stops it.',
        );
        expect(frame).toContain(
          'open a terminal, run klex, and select this Klex Bot by name.',
        );
        expect(frame.indexOf('Your bot is alive!')).toBeLessThan(
          frame.indexOf('Active Sessions'),
        );
      } else {
        expect(frame).not.toContain('Your bot is alive!');
        expect(frame).not.toContain('Note: This bot');
      }
      view.unmount();
    },
  );
});
