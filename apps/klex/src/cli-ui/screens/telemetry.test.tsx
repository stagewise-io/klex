import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { AdminApiClient } from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { ToastContext } from '../hooks/use-toast';
import { TelemetryScreen } from './telemetry';

const telemetryInstanceId = '550e8400-e29b-41d4-a716-446655440000';

describe('TelemetryScreen', () => {
  it('shows the anonymous instance ID as read-only telemetry information', async () => {
    const apiClient = {
      getTelemetry: vi.fn().mockResolvedValue({
        level: 'advanced',
        instanceId: telemetryInstanceId,
      }),
    } as unknown as AdminApiClient;
    const view = render(
      <ScreenMetaProvider>
        <ToastContext.Provider
          value={{
            toasts: [],
            pushToast: vi.fn(),
            dismissToast: vi.fn(),
          }}
        >
          <TelemetryScreen
            apiClient={apiClient}
            debugTracingEnabled={false}
            onBack={vi.fn()}
          />
        </ToastContext.Provider>
      </ScreenMetaProvider>,
    );

    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('Anonymous instance ID');
      expect(frame).toContain(telemetryInstanceId);
      expect(frame).toContain('Read-only identifier');
    });
  });
});
