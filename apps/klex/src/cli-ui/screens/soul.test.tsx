import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AdminApiClient, AdminApiClientError } from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { TextInputActiveProvider } from '../hooks/use-text-input-active';
import { ToastContext } from '../hooks/use-toast';
import { SoulScreen } from './soul';

function makeClient(overrides: Partial<AdminApiClient> = {}) {
  return {
    getSoul: vi.fn().mockResolvedValue(null),
    createSoul: vi.fn().mockResolvedValue('Created personality'),
    updateSoul: vi.fn().mockResolvedValue('Updated personality'),
    ...overrides,
  } as unknown as AdminApiClient;
}

const views: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
});
function renderScreen(apiClient = makeClient(), width = 80) {
  const onBack = vi.fn();
  const pushToast = vi.fn();
  const view = render(
    <ScreenMetaProvider>
      <TextInputActiveProvider>
        <ToastContext.Provider
          value={{ toasts: [], pushToast, dismissToast: vi.fn() }}
        >
          <SoulScreen apiClient={apiClient} onBack={onBack} />
        </ToastContext.Provider>
      </TextInputActiveProvider>
    </ScreenMetaProvider>,
  );
  Object.defineProperty(view.stdout, 'columns', {
    value: width,
    configurable: true,
  });
  view.stdout.emit('resize');
  views.push(view);
  return { ...view, onBack, pushToast };
}
async function openForm(
  view: ReturnType<typeof renderScreen>,
  key = 'c',
  label = 'Create soul',
) {
  await vi.waitFor(() =>
    expect(view.lastFrame()).toMatch(/No soul configured|Update existing soul/),
  );
  view.stdin.write(key);
  await vi.waitFor(() => expect(view.lastFrame()).toContain(label));
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Instructions'));
}
async function instructions(
  view: ReturnType<typeof renderScreen>,
  value: string,
) {
  view.stdin.write(value);
  await vi.waitFor(() => expect(view.lastFrame()).toContain(value));
}

describe('SoulScreen', () => {
  it('shows the paused empty state and navigates back', async () => {
    const view = renderScreen();
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('No soul configured'),
    );
    expect(view.lastFrame()).toContain('paused');
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(view.onBack).toHaveBeenCalledOnce());
  });

  it('validates instructions, creates via the API, and shows the saved soul', async () => {
    const client = makeClient();
    const view = renderScreen(client);
    await openForm(view);
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('must contain'));
    expect(client.createSoul).not.toHaveBeenCalled();
    await instructions(view, 'Stay curious');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(client.createSoul).toHaveBeenCalledWith(
        'Stay curious',
        expect.any(AbortSignal),
      ),
    );
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Created personality'),
    );
    expect(view.pushToast).toHaveBeenCalledWith('Soul created', 'info');
  });

  it('updates an existing soul without treating typing as menu shortcuts', async () => {
    const client = makeClient({
      getSoul: vi.fn().mockResolvedValue('Existing personality'),
    });
    const view = renderScreen(client);
    await openForm(view, 'u', 'Update soul');
    await instructions(view, 'curious');
    expect(client.createSoul).not.toHaveBeenCalled();
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(client.updateSoul).toHaveBeenCalledWith(
        'curious',
        expect.any(AbortSignal),
      ),
    );
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Updated personality'),
    );
  });

  it('refines an existing soul with empty update instructions', async () => {
    const client = makeClient({
      getSoul: vi.fn().mockResolvedValue('Existing personality'),
    });
    const view = renderScreen(client);
    await openForm(view, 'u', 'Update soul');
    expect(view.lastFrame()).toContain('leave empty to refine');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(client.updateSoul).toHaveBeenCalledWith(
        '',
        expect.any(AbortSignal),
      ),
    );
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Updated personality'),
    );
  });

  it('requires confirmation to re-create and preserves the draft when cancelled', async () => {
    const client = makeClient({
      getSoul: vi.fn().mockResolvedValue('Existing personality'),
      createSoul: vi.fn().mockResolvedValue('Fresh personality'),
    });
    const view = renderScreen(client);
    await openForm(view, 'r', 'Re-create soul');
    await instructions(view, 'Start fresh');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Re-create soul?'),
    );
    expect(client.createSoul).not.toHaveBeenCalled();
    view.stdin.write('n');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Start fresh'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Re-create soul?'),
    );
    view.stdin.write('y');
    await vi.waitFor(() =>
      expect(client.createSoul).toHaveBeenCalledWith(
        'Start fresh',
        expect.any(AbortSignal),
      ),
    );
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Fresh personality'),
    );
  });

  it('keeps instructions and the saved soul after failed generation', async () => {
    const client = makeClient({
      getSoul: vi.fn().mockResolvedValue('Existing personality'),
      updateSoul: vi
        .fn()
        .mockRejectedValue(
          new AdminApiClientError('No chat models configured', 503),
        ),
    });
    const view = renderScreen(client);
    await openForm(view, 'u', 'Update soul');
    await instructions(view, 'Less formal');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('No chat models configured'),
    );
    expect(view.lastFrame()).toContain('Less formal');
    view.stdin.write('\u001b');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Existing personality'),
    );
    expect(view.onBack).not.toHaveBeenCalled();
  });

  it('retries reads after a failure and disables creation until loaded', async () => {
    const client = makeClient({
      getSoul: vi
        .fn()
        .mockRejectedValueOnce(new Error('Offline'))
        .mockResolvedValue(null),
    });
    const view = renderScreen(client);
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Failed to load soul'),
    );
    view.stdin.write('c');
    expect(view.lastFrame()).not.toContain('Instructions');
    view.stdin.write('r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('No soul configured'),
    );
    expect(client.getSoul).toHaveBeenCalledTimes(2);
  });

  it('aborts generation on Escape and ignores a late success', async () => {
    const pending = Promise.withResolvers<string>();
    const createSoul = vi.fn().mockReturnValue(pending.promise);
    const view = renderScreen(makeClient({ createSoul }));
    await openForm(view);
    await instructions(view, 'Stay curious');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Generating with'),
    );
    const signal = createSoul.mock.calls[0]?.[1] as AbortSignal;
    view.stdin.write('\u001b');
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Stay curious'));
    pending.resolve('Late result');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).not.toContain('Late result');
    expect(view.pushToast).not.toHaveBeenCalled();
  });

  it('aborts active generation when the screen unmounts', async () => {
    const createSoul = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    const view = renderScreen(makeClient({ createSoul }));
    await openForm(view);
    await instructions(view, 'Stay curious');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(createSoul).toHaveBeenCalledOnce());
    const signal = createSoul.mock.calls[0]?.[1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it.each([40, 80, 120])(
    'wraps and scrolls all soul rows at %i columns',
    async (width) => {
      const soul = `HEAD-${'x'.repeat(1200)}-TAIL`;
      const view = renderScreen(
        makeClient({ getSoul: vi.fn().mockResolvedValue(soul) }),
        width,
      );
      await vi.waitFor(() => expect(view.lastFrame()).toContain('HEAD'));
      expect(view.lastFrame()).not.toContain('TAIL');
      for (let index = 0; index < 50; index++) view.stdin.write('\u001b[B');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('TAIL'));
      expect(view.lastFrame()).not.toContain('HEAD');
      expect(
        (view.lastFrame() ?? '')
          .split('\n')
          .every((line) => line.length <= width),
      ).toBe(true);
      expect((view.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(
        24,
      );
    },
  );

  it('bounds long instructions and follows the editing cursor', async () => {
    const view = renderScreen();
    await openForm(view);
    view.stdin.write(`HEAD-${'x'.repeat(1200)}-TAIL`);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('TAIL'));
    expect(view.lastFrame()).not.toContain('HEAD');
    expect((view.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(24);
    view.stdin.write('\u001b[H');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('HEAD'));
    expect(view.lastFrame()).not.toContain('TAIL');
  });
});
