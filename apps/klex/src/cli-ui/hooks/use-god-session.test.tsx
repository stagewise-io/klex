import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminApiClient,
  GodMessagesResponse,
  SerializedMessage,
  SessionInfo,
} from '../api-client';
import { type UseGodSessionResult, useGodSession } from './use-god-session';

function session(id: string): SessionInfo {
  return {
    id,
    status: 'active',
    runtimeState: 'idle',
    model: { id: 'test:model', isFallback: false, fallbackIndex: 0 },
    usage: { chat: { latest: null, total: {} }, extensions: {} },
    turns: 0,
    steps: 0,
    messageCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function message(id: string): SerializedMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text: id }] };
}

function page(
  messages: SerializedMessage[],
  nextCursor: string | null = null,
  hasMore = false,
): GodMessagesResponse {
  return { messages, nextCursor, hasMore };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clientWith(
  getGodSession: AdminApiClient['getGodSession'],
  getGodMessages: AdminApiClient['getGodMessages'],
): AdminApiClient {
  return {
    getGodSession,
    getGodMessages,
  } as unknown as AdminApiClient;
}

let latestResult: UseGodSessionResult | null = null;

function Harness({ client }: { client: AdminApiClient }) {
  latestResult = useGodSession(client);
  return (
    <Text>
      {JSON.stringify({
        session: latestResult.session?.id ?? null,
        ids: latestResult.allMessages.map(({ id }) => id),
        loading: latestResult.loading,
        error: latestResult.error?.message ?? null,
        hasMore: latestResult.hasMore,
        loadingMore: latestResult.loadingMore,
      })}
    </Text>
  );
}

async function waitForFrame(
  lastFrame: () => string | undefined,
  expected: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(lastFrame()?.replaceAll('\n', '')).toContain(expected);
  });
}

afterEach(() => {
  latestResult = null;
  vi.useRealTimers();
});

describe('useGodSession', () => {
  it('polls the chat every five seconds', async () => {
    vi.useFakeTimers();
    const getGodSession = vi.fn().mockResolvedValue(session('session-1'));
    const getGodMessages = vi.fn().mockResolvedValue(page([]));
    const view = render(
      <Harness client={clientWith(getGodSession, getGodMessages)} />,
    );

    expect(getGodMessages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getGodMessages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getGodMessages).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('loads the current session and latest messages', async () => {
    const client = clientWith(
      vi.fn().mockResolvedValue(session('session-1')),
      vi.fn().mockResolvedValue(page([message('m1')], 'm1', true)),
    );
    const view = render(<Harness client={client} />);

    await waitForFrame(view.lastFrame, '"session":"session-1"');
    const frame = view.lastFrame()?.replaceAll('\n', '');
    expect(frame).toContain('"ids":["m1"]');
    expect(frame).toContain('"loading":false');
    expect(frame).toContain('"hasMore":true');
    view.unmount();
  });

  it('surfaces polling errors and clears them after recovery', async () => {
    const getGodSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('session unavailable'))
      .mockResolvedValue(session('recovered'));
    const getGodMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error('messages unavailable'))
      .mockResolvedValue(page([message('m1')]));
    const view = render(
      <Harness client={clientWith(getGodSession, getGodMessages)} />,
    );

    await waitForFrame(view.lastFrame, 'sessionunavailable');
    latestResult?.refresh();
    await waitForFrame(view.lastFrame, '"session":"recovered"');
    expect(view.lastFrame()?.replaceAll('\n', '')).toContain('"error":null');
    view.unmount();
  });

  it('serializes overlapping refresh requests and applies the newest result', async () => {
    const firstSession = deferred<SessionInfo>();
    const firstMessages = deferred<GodMessagesResponse>();
    const getGodSession = vi
      .fn()
      .mockReturnValueOnce(firstSession.promise)
      .mockResolvedValue(session('session-2'));
    const getGodMessages = vi
      .fn()
      .mockReturnValueOnce(firstMessages.promise)
      .mockResolvedValue(page([message('m2')]));
    const view = render(
      <Harness client={clientWith(getGodSession, getGodMessages)} />,
    );

    await vi.waitFor(() => expect(getGodSession).toHaveBeenCalledTimes(1));
    latestResult?.refresh();
    latestResult?.refresh();
    expect(getGodSession).toHaveBeenCalledTimes(1);

    firstSession.resolve(session('session-1'));
    firstMessages.resolve(page([message('m1')]));

    await waitForFrame(view.lastFrame, '"session":"session-2"');
    expect(getGodSession).toHaveBeenCalledTimes(2);
    expect(getGodMessages).toHaveBeenCalledTimes(2);
    expect(view.lastFrame()?.replaceAll('\n', '')).toContain('"ids":["m2"]');
    view.unmount();
  });

  it('deduplicates older pages and blocks concurrent pagination calls', async () => {
    const olderPage = deferred<GodMessagesResponse>();
    const getGodMessages = vi
      .fn()
      .mockResolvedValueOnce(page([message('m2'), message('m3')], 'm2', true))
      .mockReturnValueOnce(olderPage.promise);
    const view = render(
      <Harness
        client={clientWith(
          vi.fn().mockResolvedValue(session('session-1')),
          getGodMessages,
        )}
      />,
    );

    await waitForFrame(view.lastFrame, '"hasMore":true');
    latestResult?.loadMore();
    latestResult?.loadMore();
    expect(getGodMessages).toHaveBeenCalledTimes(2);

    olderPage.resolve(page([message('m1'), message('m2')]));
    await waitForFrame(view.lastFrame, '"ids":["m1","m2","m3"]');
    expect(view.lastFrame()?.replaceAll('\n', '')).toContain(
      '"loadingMore":false',
    );
    view.unmount();
  });

  it('clears paginated history when polling discovers a new session', async () => {
    const getGodSession = vi
      .fn()
      .mockResolvedValueOnce(session('session-1'))
      .mockResolvedValue(session('session-2'));
    const getGodMessages = vi
      .fn()
      .mockResolvedValueOnce(page([message('m2')], 'm2', true))
      .mockResolvedValueOnce(page([message('m1')]))
      .mockResolvedValue(page([message('m3')]));
    const view = render(
      <Harness client={clientWith(getGodSession, getGodMessages)} />,
    );

    await waitForFrame(view.lastFrame, '"hasMore":true');
    latestResult?.loadMore();
    await waitForFrame(view.lastFrame, '"ids":["m1","m2"]');

    latestResult?.refresh();
    await waitForFrame(view.lastFrame, '"session":"session-2"');
    const frame = view.lastFrame()?.replaceAll('\n', '');
    expect(frame).toContain('"ids":["m3"]');
    expect(frame).not.toContain('m1');
    expect(frame).not.toContain('m2');
    view.unmount();
  });

  it('releases pagination state when the session changes mid-request', async () => {
    const staleOlderPage = deferred<GodMessagesResponse>();
    const currentOlderPage = deferred<GodMessagesResponse>();
    const getGodSession = vi
      .fn()
      .mockResolvedValueOnce(session('session-1'))
      .mockResolvedValue(session('session-2'));
    const getGodMessages = vi
      .fn()
      .mockResolvedValueOnce(page([message('old-latest')], 'old', true))
      .mockReturnValueOnce(staleOlderPage.promise)
      .mockResolvedValueOnce(page([message('new-latest')], 'new', true))
      .mockReturnValueOnce(currentOlderPage.promise);
    const view = render(
      <Harness client={clientWith(getGodSession, getGodMessages)} />,
    );

    await waitForFrame(view.lastFrame, '"hasMore":true');
    latestResult?.loadMore();
    await waitForFrame(view.lastFrame, '"loadingMore":true');

    latestResult?.refresh();
    await waitForFrame(view.lastFrame, '"session":"session-2"');
    await waitForFrame(view.lastFrame, '"loadingMore":false');

    latestResult?.loadMore();
    await vi.waitFor(() => expect(getGodMessages).toHaveBeenCalledTimes(4));
    staleOlderPage.resolve(page([message('stale-older')]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.lastFrame()?.replaceAll('\n', '')).toContain(
      '"loadingMore":true',
    );

    currentOlderPage.resolve(page([message('new-older')]));
    await waitForFrame(view.lastFrame, '"ids":["new-older","new-latest"]');
    expect(view.lastFrame()?.replaceAll('\n', '')).toContain(
      '"loadingMore":false',
    );
    view.unmount();
  });

  it('clears stale state before refreshing a reset session', async () => {
    const firstSession = deferred<SessionInfo>();
    const firstMessages = deferred<GodMessagesResponse>();
    const getGodSession = vi
      .fn()
      .mockReturnValueOnce(firstSession.promise)
      .mockResolvedValue(session('fresh'));
    const getGodMessages = vi
      .fn()
      .mockReturnValueOnce(firstMessages.promise)
      .mockResolvedValue(page([message('fresh-message')]));
    const view = render(
      <Harness client={clientWith(getGodSession, getGodMessages)} />,
    );

    await vi.waitFor(() => expect(getGodSession).toHaveBeenCalledTimes(1));
    latestResult?.resetState();
    latestResult?.refresh();
    firstSession.resolve(session('stale'));
    firstMessages.resolve(page([message('stale-message')]));

    await waitForFrame(view.lastFrame, '"session":"fresh"');
    const frame = view.lastFrame()?.replaceAll('\n', '');
    expect(frame).toContain('"ids":["fresh-message"]');
    expect(frame).not.toContain('stale-message');
    view.unmount();
  });
});
