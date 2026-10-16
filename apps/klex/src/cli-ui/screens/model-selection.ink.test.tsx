import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminApiClient,
  ModelSelection,
  ProviderInfo,
} from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
import { TextInputActiveProvider } from '../hooks/use-text-input-active';
import { ToastContext } from '../hooks/use-toast';
import { ModelSelectionScreen } from './model-selection';

const emptySelection: ModelSelection = {
  chat: [],
  consult: [],
  compaction: [],
  memory: [],
  imageVision: [],
  audioListening: [],
  instincts: [],
  voice: { sts: [], tts: [], stt: [] },
};

function provider(id: string): ProviderInfo {
  return {
    id,
    type: 'openai',
    settings: { apiKey: { configured: true } },
    metadata: {
      displayName: 'OpenAI',
      description: 'OpenAI transport',
      capabilities: {
        modelDiscovery: true,
        connectivityTest: true,
        customModels: true,
        generation: true,
        evaluation: true,
      },
    },
    operations: {
      update: { available: true },
      remove: { available: true },
    },
  };
}

function makeClient(overrides: Partial<AdminApiClient> = {}): AdminApiClient {
  return {
    getModelSelection: vi.fn().mockResolvedValue(emptySelection),
    getProviders: vi.fn().mockResolvedValue({
      providers: [provider('openai-primary'), provider('openai-secondary')],
    }),
    getKnownModels: vi.fn().mockResolvedValue({
      models: [
        {
          modelId: 'vendor:model:latest',
          displayName: 'Latest',
          source: 'discovered',
        },
      ],
    }),
    createKnownModel: vi.fn().mockResolvedValue({ models: [] }),
    patchModelSelection: vi.fn().mockResolvedValue(emptySelection),
    ...overrides,
  } as unknown as AdminApiClient;
}

function renderScreen(client: AdminApiClient) {
  return render(
    <ScreenMetaProvider>
      <TextInputActiveProvider>
        <ToastContext.Provider
          value={{ toasts: [], pushToast: vi.fn(), dismissToast: vi.fn() }}
        >
          <ModelSelectionScreen apiClient={client} onBack={vi.fn()} />
        </ToastContext.Provider>
      </TextInputActiveProvider>
    </ScreenMetaProvider>,
  );
}

async function openModelPicker(
  view: ReturnType<typeof renderScreen>,
): Promise<void> {
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Chat'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write('\r');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('No models'));
  view.stdin.write('a');
  await vi.waitFor(() => {
    expect(view.lastFrame()).toContain('openai-primary');
    expect(view.lastFrame()).toContain('openai-secondary');
  });
  view.stdin.write('\r');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Latest'));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function typeText(
  view: ReturnType<typeof renderScreen>,
  text: string,
): Promise<void> {
  for (const character of text) {
    view.stdin.write(character);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('ModelSelectionScreen', () => {
  it('adds a second API, preserves ordered options, and edits its production budget without test controls', async () => {
    let selection: ModelSelection = {
      ...emptySelection,
      instincts: [
        {
          providerId: 'openai-primary',
          modelId: 'vendor:model:latest',
          api: 'generation',
          attemptTimeoutMs: 900,
          providerOptions: { openai: { mode: 'original' } },
        },
      ],
    };
    const patchModelSelection = vi.fn(
      async (patch: { instincts: ModelSelection['instincts'] }) => {
        selection = { ...selection, ...patch };
        return selection;
      },
    );
    const view = renderScreen(
      makeClient({
        getModelSelection: vi.fn().mockResolvedValue(selection),
        patchModelSelection,
      }),
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Instincts'));
    for (let index = 0; index < 3; index++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      view.stdin.write('\u001B[B');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[generation]'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('a');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('openai-primary'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Latest'));
    // Ink registers the picker's input handler in an effect after the frame.
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('evaluation —'));
    view.stdin.write('\u001B[B');
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(selection.instincts).toHaveLength(2));
    expect(selection.instincts[1]).toMatchObject({
      api: 'evaluation',
      attemptTimeoutMs: 1500,
    });
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('API: evaluation'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\u001B[1;2A');
    await vi.waitFor(() =>
      expect(selection.instincts[0]?.api).toBe('evaluation'),
    );
    expect(selection.instincts[1]).toMatchObject({
      api: 'generation',
      attemptTimeoutMs: 900,
      providerOptions: { openai: { mode: 'original' } },
    });
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain(
        '❯ 1. openai-primary:vendor:model:latest [evaluation]',
      );
      expect(view.lastFrame()).not.toContain('Saving model selection');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('e');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Attempt timeout in ms'),
    );
    for (let index = 0; index < 4; index++) {
      view.stdin.write('\u007F');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await typeText(view, '2500');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('2500 ms'));
    expect(selection.instincts[0]?.attemptTimeoutMs).toBe(2500);
    const savedSelection = structuredClone(selection);
    const patchCount = patchModelSelection.mock.calls.length;
    view.stdin.write('t');
    view.stdin.write('r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.lastFrame()).toContain('API: evaluation');
    expect(view.lastFrame()).not.toContain('Synthetic');
    expect(selection).toEqual(savedSelection);
    expect(patchModelSelection).toHaveBeenCalledTimes(patchCount);
    view.unmount();
  });

  it.each([
    { purpose: 'consult', label: 'Consult', index: 1 },
    { purpose: 'instincts', label: 'Instincts', index: 3 },
  ])(
    'lists and patches the $purpose model purpose',
    async ({ purpose, label, index }) => {
      const initial: ModelSelection = { ...emptySelection };
      const patchModelSelection = vi.fn().mockResolvedValue(initial);
      const view = renderScreen(
        makeClient({
          getModelSelection: vi.fn().mockResolvedValue(initial),
          patchModelSelection,
        }),
      );

      await vi.waitFor(() => expect(view.lastFrame()).toContain(label));
      if (purpose === 'instincts') {
        const frame = view.lastFrame() ?? '';
        expect(frame.indexOf('Compaction')).toBeLessThan(
          frame.indexOf('Instincts'),
        );
        expect(frame.indexOf('Instincts')).toBeLessThan(
          frame.indexOf('Memory'),
        );
      }
      for (let i = 0; i < index; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        view.stdin.write('\u001B[B');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      view.stdin.write('\r');
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain(
          purpose === 'instincts'
            ? 'Uses Chat models via generation'
            : 'No models',
        ),
      );
      view.stdin.write('a');
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('openai-primary'),
      );
      view.stdin.write('\r');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Latest'));
      view.stdin.write('\r');
      if (purpose === 'instincts') {
        await vi.waitFor(() =>
          expect(view.lastFrame()).toContain('generation —'),
        );
        view.stdin.write('\r');
      }

      await vi.waitFor(() =>
        expect(patchModelSelection).toHaveBeenCalledWith({
          [purpose]: [
            {
              providerId: 'openai-primary',
              modelId: 'vendor:model:latest',
              ...(purpose === 'instincts' && {
                api: 'generation',
                attemptTimeoutMs: 1500,
              }),
            },
          ],
        }),
      );
      view.unmount();
    },
  );

  it('reorders model priority with Shift+Arrow keys', async () => {
    const initial: ModelSelection = {
      ...emptySelection,
      chat: [
        { providerId: 'openai-primary', modelId: 'primary-model' },
        { providerId: 'openai-secondary', modelId: 'second-model' },
        { providerId: 'openai-primary', modelId: 'third-model' },
      ],
    };
    const reordered: ModelSelection = {
      ...initial,
      chat: [
        { providerId: 'openai-secondary', modelId: 'second-model' },
        { providerId: 'openai-primary', modelId: 'primary-model' },
        { providerId: 'openai-primary', modelId: 'third-model' },
      ],
    };
    const patchModelSelection = vi.fn().mockResolvedValue(reordered);
    const view = renderScreen(
      makeClient({
        getModelSelection: vi.fn().mockResolvedValue(initial),
        patchModelSelection,
      }),
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Chat'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('primary-model (primary)');
      expect(view.lastFrame()).toContain('second-model (fallback #1)');
    });
    view.stdin.write('\u001B[B');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('❯ 2. openai-secondary:second-model'),
    );
    view.stdin.write('\u001B[1;2A');

    await vi.waitFor(() =>
      expect(patchModelSelection).toHaveBeenCalledWith({
        chat: [
          { providerId: 'openai-secondary', modelId: 'second-model' },
          { providerId: 'openai-primary', modelId: 'primary-model' },
          { providerId: 'openai-primary', modelId: 'third-model' },
        ],
      }),
    );
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('second-model (primary)');
      expect(view.lastFrame()).toContain('primary-model (fallback #1)');
    });
    view.unmount();
  });

  it.each(['success', 'failure'] as const)(
    'blocks overlapping priority changes and preserves the confirmed highlight after %s',
    async (outcome) => {
      const first = { providerId: 'openai-primary', modelId: 'first' };
      const second = { providerId: 'openai-primary', modelId: 'second' };
      const third = { providerId: 'openai-primary', modelId: 'third' };
      const initial: ModelSelection = {
        ...emptySelection,
        chat: [first, second, third],
      };
      let resolve!: (value: ModelSelection) => void;
      let reject!: (error: Error) => void;
      const patchModelSelection = vi.fn(
        () =>
          new Promise<ModelSelection>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const view = renderScreen(
        makeClient({
          getModelSelection: vi.fn().mockResolvedValue(initial),
          patchModelSelection,
        }),
      );
      try {
        await vi.waitFor(() => expect(view.lastFrame()).toContain('Chat'));
        await new Promise((done) => setTimeout(done, 0));
        view.stdin.write('\r');
        await vi.waitFor(() =>
          expect(view.lastFrame()).toContain('❯ 1. openai-primary:first'),
        );
        view.stdin.write('\u001B[1;2B');
        // Same-frame input must be locked before React renders pending state.
        view.stdin.write('\u001B[1;2B');
        await vi.waitFor(() =>
          expect(patchModelSelection).toHaveBeenCalledTimes(1),
        );
        expect(patchModelSelection).toHaveBeenLastCalledWith({
          chat: [second, first, third],
        });
        // A second move used to mix the new highlight with the old list.
        view.stdin.write('\u001B[1;2B');
        view.stdin.write('\u001B[B');
        view.stdin.write('a');
        await vi.waitFor(() =>
          expect(view.lastFrame()).toContain('Saving model selection'),
        );
        expect(patchModelSelection).toHaveBeenCalledTimes(1);
        expect(view.lastFrame()).toContain('❯ 1. openai-primary:first');
        if (outcome === 'success')
          resolve({
            ...initial,
            chat: [second, first, third],
          });
        else reject(new Error('synthetic update failure'));
        await vi.waitFor(() => {
          expect(view.lastFrame()).not.toContain('Saving model selection');
          expect(view.lastFrame()).toContain(
            outcome === 'success'
              ? '❯ 2. openai-primary:first'
              : '❯ 1. openai-primary:first',
          );
        });
        // Further movement uses the confirmed list and the same selected model.
        view.stdin.write('\u001B[1;2B');
        await vi.waitFor(() =>
          expect(patchModelSelection).toHaveBeenCalledTimes(2),
        );
        const expected =
          outcome === 'success'
            ? [second, third, first]
            : [second, first, third];
        expect(patchModelSelection).toHaveBeenLastCalledWith({
          chat: expected,
        });
        view.stdin.write('\u001B[1;2A');
        await new Promise((done) => setTimeout(done, 0));
        expect(patchModelSelection).toHaveBeenCalledTimes(2);
        resolve({ ...initial, chat: expected });
        await vi.waitFor(() =>
          expect(view.lastFrame()).not.toContain('Saving model selection'),
        );
      } finally {
        view.unmount();
      }
    },
  );

  it('selects a discovered model by explicit provider instance', async () => {
    const patchModelSelection = vi.fn().mockResolvedValue(emptySelection);
    const view = renderScreen(makeClient({ patchModelSelection }));
    await openModelPicker(view);
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(patchModelSelection).toHaveBeenCalledWith({
        chat: [
          {
            providerId: 'openai-primary',
            modelId: 'vendor:model:latest',
          },
        ],
      }),
    );
    view.unmount();
  });

  it('lists and selects discovered Codex subscription models', async () => {
    const codex = provider('codex-subscription');
    codex.type = 'chatgpt-codex-subscription';
    codex.metadata.displayName = 'ChatGPT Codex Subscription';
    const patchModelSelection = vi.fn().mockResolvedValue(emptySelection);
    const view = renderScreen(
      makeClient({
        getProviders: vi.fn().mockResolvedValue({ providers: [codex] }),
        getKnownModels: vi.fn().mockResolvedValue({
          models: [
            {
              modelId: 'gpt-5.2-codex',
              displayName: 'GPT-5.2 Codex',
              source: 'discovered',
            },
            {
              modelId: 'gpt-5.3-codex',
              displayName: 'GPT-5.3 Codex',
              source: 'discovered',
            },
          ],
        }),
        patchModelSelection,
      }),
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Chat'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('No models'));
    view.stdin.write('a');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('codex-subscription'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('GPT-5.2 Codex');
      expect(view.lastFrame()).toContain('GPT-5.3 Codex');
    });
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(patchModelSelection).toHaveBeenCalledWith({
        chat: [{ providerId: 'codex-subscription', modelId: 'gpt-5.2-codex' }],
      }),
    );
    view.unmount();
  });

  it('bounds, scrolls, and filters the known-model list', async () => {
    const view = renderScreen(
      makeClient({
        getKnownModels: vi.fn().mockResolvedValue({
          models: Array.from({ length: 12 }, (_, index) => ({
            modelId: `model-${index.toString().padStart(2, '0')}`,
            displayName: `Model ${index.toString().padStart(2, '0')}`,
            source: 'discovered' as const,
          })),
        }),
      }),
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('Chat'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('No models'));
    view.stdin.write('a');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('openai-primary'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Filter:');
      expect(view.lastFrame()).toContain('Model 00');
      expect(view.lastFrame()).not.toContain('Model 10');
      expect(view.lastFrame()).toContain('█');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    view.stdin.write('/');
    await typeText(view, 'mD 11');
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Model 11');
      expect(view.lastFrame()).not.toContain('Model 00');
    });
    view.unmount();
  });

  it('persists a manual model before selecting it', async () => {
    const createKnownModel = vi.fn().mockResolvedValue({ models: [] });
    const patchModelSelection = vi.fn().mockResolvedValue(emptySelection);
    const view = renderScreen(
      makeClient({ createKnownModel, patchModelSelection }),
    );
    await openModelPicker(view);
    view.stdin.write('\u001B[B');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Enter a manual model ID…'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Model ID'));
    expect(view.lastFrame()).toContain('Provider: OpenAI (openai-primary)');
    await typeText(view, 'custom/vendor:model:v2');
    view.stdin.write('\r');

    await vi.waitFor(() => {
      expect(createKnownModel).toHaveBeenCalledWith('openai-primary', {
        modelId: 'custom/vendor:model:v2',
        displayName: 'custom/vendor:model:v2',
      });
      expect(patchModelSelection).toHaveBeenCalledWith({
        chat: [
          {
            providerId: 'openai-primary',
            modelId: 'custom/vendor:model:v2',
          },
        ],
      });
    });
    expect(createKnownModel.mock.invocationCallOrder[0]).toBeLessThan(
      patchModelSelection.mock.invocationCallOrder[0] ?? 0,
    );
    view.unmount();
  });
});
