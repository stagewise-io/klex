import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { AdminApiClient } from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { ToastContext } from '../hooks/use-toast';
import { UsageScreen } from './usage';

describe('UsageScreen', () => {
  it('separates and pads every usage table column', async () => {
    const apiClient = {
      getUsage: vi.fn().mockResolvedValue({
        dataPoints: [
          {
            bucket: null,
            splitKey: 'openai/gpt-5',
            callCount: 2,
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
  });
});
