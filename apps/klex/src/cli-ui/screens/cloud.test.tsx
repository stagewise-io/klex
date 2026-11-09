import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { AdminApiClient } from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { TextInputActiveProvider } from '../hooks/use-text-input-active';
import { ToastContext } from '../hooks/use-toast';
import { CloudScreen } from './cloud';

describe('CloudScreen enrollment handoff', () => {
  it.each([false, true])(
    'hands off only after successful enrollment, failed=%s',
    async (failed) => {
      const onEnrolled = vi.fn();
      const enroll = failed
        ? vi.fn().mockRejectedValue(new Error('Failed'))
        : vi.fn().mockResolvedValue({ clientId: 'bot' });
      const apiClient = {
        getCloudStatus: vi.fn().mockResolvedValue({
          cloudEnabled: true,
          enrolled: false,
          cloudBaseUrl: 'https://cloud.klex.ai',
        }),
        enroll,
      } as unknown as AdminApiClient;
      const view = render(
        <ScreenMetaProvider>
          <TextInputActiveProvider>
            <ToastContext.Provider
              value={{ toasts: [], pushToast: vi.fn(), dismissToast: vi.fn() }}
            >
              <CloudScreen
                apiClient={apiClient}
                onBack={vi.fn()}
                onEnrolled={onEnrolled}
              />
            </ToastContext.Provider>
          </TextInputActiveProvider>
        </ScreenMetaProvider>,
      );
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('How to enroll:'),
      );
      view.stdin.write('c');
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('Paste your enrollment code'),
      );
      view.stdin.write('test-token');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('test-token'));
      view.stdin.write('\r');
      await vi.waitFor(() => expect(enroll).toHaveBeenCalledWith('test-token'));
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('How to enroll:'),
      );
      expect(onEnrolled).toHaveBeenCalledTimes(failed ? 0 : 1);
      view.unmount();
    },
  );
});
