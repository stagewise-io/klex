import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { AdminApiClient } from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { ToastContext } from '../hooks/use-toast';
import { UsageScreen } from './usage';

describe('UsageScreen', () => {
  it.each([0, 1])(
    'renders aligned usage and marks incomplete reporting (unreported=%s)',
    async (unreportedCount) => {
      const apiClient = {
        getUsage: vi.fn().mockResolvedValue({
          dataPoints: [
            {
              bucket: null,
              splitKey: 'openai/gpt-5',
              callCount: 2,
              tokenUsageUnreportedCount: unreportedCount,
              cacheUsageUnreportedCount: unreportedCount,
              inputTokens: 1200,
              outputTokens: 450,
              inputCacheWriteTokens: 30,
              inputCacheReadTokens: 80,
              ttftMs: null,
              totalDurationMs: null,
              errorCount: 1,
              id: null,
              sessionId: null,
              providerId: 'openai',
              endpointId: null,
              modelId: 'gpt-5',
              source: 'chat',
              extensionId: null,
              finishReason: null,
              errorType: null,
              startedAt: null,
              finishedAt: null,
            },
          ],
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
            <UsageScreen apiClient={apiClient} onBack={vi.fn()} />
          </ToastContext.Provider>
        </ScreenMetaProvider>,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      const frame = view.lastFrame() ?? '';

      expect(frame).toContain('╭');
      expect(frame).toContain('┬');
      expect(frame).toContain('├');
      expect(frame).toContain('┼');
      expect(frame).toContain('│ Model');
      expect(frame).toContain('│  Calls │');
      expect(frame).toContain('openai/gpt-5');
      expect(frame).toContain('╰');
      expect(frame).toContain('┴');
      const prefix = unreportedCount > 0 ? '≥' : '';
      for (const label of ['openai/gpt-5', 'Total']) {
        const cells = frame
          .split('\n')
          .find((line) => line.startsWith(`│ ${label}`))
          ?.split('│')
          .slice(1, -1)
          .map((cell) => cell.trim());
        expect(cells).toEqual([
          label,
          '2',
          `${prefix}1.2K`,
          `${prefix}450`,
          `${prefix}30`,
          `${prefix}80`,
          '1',
        ]);
      }
      if (unreportedCount > 0) {
        expect(frame).toContain('≥1.2K');
        expect(frame).toContain('≥450');
        expect(frame).toContain('≥30');
        expect(frame).toContain('≥80');
        expect(frame).toContain(
          'Incomplete reporting: 1 calls missing token totals; 1 missing cache',
        );
        expect(frame).toContain('reported lower bounds');
      } else {
        expect(frame).not.toContain('≥');
        expect(frame).not.toContain('Incomplete reporting');
      }
      view.unmount();
    },
  );
});
