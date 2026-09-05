import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { AdminApiClient, SessionInfo } from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { TextInputActiveProvider } from '../hooks/use-text-input-active';
import { ToastContext } from '../hooks/use-toast';
import { GodMessagesScreen } from './god-messages';

function session(runtimeState = 'idle'): SessionInfo {
  return {
    id: 'session-12345678',
    status: 'active',
    runtimeState,
    model: { id: 'test:model', isFallback: false, fallbackIndex: 0 },
    usage: { chat: { latest: null, total: {} }, extensions: {} },
    turns: 1,
    steps: 2,
    messageCount: 0,
    createdAt: new Date().toISOString(),
  };
}

function makeClient(overrides: Partial<AdminApiClient> = {}): AdminApiClient {
  return {
    getGodSession: vi.fn().mockResolvedValue(session()),
    getGodMessages: vi.fn().mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
    }),
    resetGodSession: vi.fn().mockResolvedValue({ sessionId: 'fresh-session' }),
    sendGodMessage: vi
      .fn()
      .mockResolvedValue({ sessionId: 'session-12345678' }),
    ...overrides,
  } as unknown as AdminApiClient;
}

function renderScreen(client: AdminApiClient) {
  return render(
    <ScreenMetaProvider>
      <TextInputActiveProvider>
        <ToastContext.Provider
          value={{
            toasts: [],
            pushToast: vi.fn(),
            dismissToast: vi.fn(),
          }}
        >
          <GodMessagesScreen apiClient={client} onBack={vi.fn()} />
        </ToastContext.Provider>
      </TextInputActiveProvider>
    </ScreenMetaProvider>,
  );
}

async function typeText(
  view: ReturnType<typeof renderScreen>,
  text: string,
): Promise<void> {
  let typed = '';
  for (const character of text) {
    typed += character;
    view.stdin.write(character);
    await vi.waitFor(() => expect(view.lastFrame()).toContain(typed));
  }
}

describe('GodMessagesScreen', () => {
  it('renders polling errors instead of silently showing no session', async () => {
    const view = renderScreen(
      makeClient({
        getGodSession: vi.fn().mockRejectedValue(new Error('API unavailable')),
      }),
    );

    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('API unavailable');
    });
    view.unmount();
  });

  it('confirms and performs an idle-session reset', async () => {
    const resetGodSession = vi
      .fn()
      .mockResolvedValue({ sessionId: 'fresh-session' });
    const view = renderScreen(makeClient({ resetGodSession }));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('IDLE'));

    view.stdin.write('r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Confirm Reset'));
    view.stdin.write('y');
    await vi.waitFor(() => expect(resetGodSession).toHaveBeenCalledOnce());
    view.unmount();
  });

  it('does not open reset confirmation while the session is busy', async () => {
    const view = renderScreen(
      makeClient({
        getGodSession: vi.fn().mockResolvedValue(session('working')),
      }),
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('WORKING'));

    view.stdin.write('r');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(view.lastFrame()).not.toContain('Confirm Reset');
    expect(view.lastFrame()).toContain('reset (busy)');
    view.unmount();
  });

  it('labels directives as God and separates messages', async () => {
    const view = renderScreen(
      makeClient({
        getGodMessages: vi.fn().mockResolvedValue({
          messages: [
            {
              id: 'god-1',
              role: 'user',
              parts: [
                {
                  type: 'data-god-message',
                  data: { content: [{ type: 'text', text: 'Do it' }] },
                },
              ],
            },
            {
              id: 'agent-1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Done' }],
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      }),
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Done'));
    const lines = (view.lastFrame() ?? '').split('\n');
    const directiveLine = lines.findIndex((line) => line.includes('Do it'));
    const agentLine = lines.findIndex((line) => line.includes('Agent'));
    expect(lines.some((line) => line.includes('God'))).toBe(true);
    expect(agentLine - directiveLine).toBeGreaterThan(1);
    view.unmount();
  });

  it('composes inline with Enter and sends a non-empty message', async () => {
    const sendGodMessage = vi
      .fn()
      .mockResolvedValue({ sessionId: 'session-12345678' });
    const getGodMessages = vi.fn().mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
    });
    const view = renderScreen(makeClient({ sendGodMessage, getGodMessages }));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('IDLE'));

    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Editing message'),
    );
    expect(view.lastFrame()).toContain('God Messages');
    await typeText(view, 'Do it');
    view.stdin.write('\r');

    await vi.waitFor(() => {
      expect(sendGodMessage).toHaveBeenCalledWith('Do it');
      expect(getGodMessages).toHaveBeenCalledTimes(2);
    });
    view.unmount();
  });

  it('keeps an escaped draft and resumes editing it with Enter', async () => {
    const sendGodMessage = vi.fn();
    const view = renderScreen(makeClient({ sendGodMessage }));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('IDLE'));

    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Editing message'),
    );
    await typeText(view, 'Keep me');
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('edit draft'));
    expect(view.lastFrame()).toContain('Keep me');

    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Editing message'),
    );
    await typeText(view, '!');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(sendGodMessage).toHaveBeenCalledWith('Keep me!'),
    );
    view.unmount();
  });

  it('does not send an empty or whitespace-only draft', async () => {
    const sendGodMessage = vi.fn();
    const view = renderScreen(makeClient({ sendGodMessage }));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('IDLE'));

    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Editing message'),
    );
    view.stdin.write(' ');
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(sendGodMessage).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('Editing message');
    view.unmount();
  });
});
