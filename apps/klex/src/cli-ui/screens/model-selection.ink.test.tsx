import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminApiClient,
  InstinctOperationTestResult,
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
  it('adds a second API, preserves ordered options, edits its budget, and tests only after confirmation', async () => {
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
    const result: InstinctOperationTestResult = {
      providerId: 'openai-primary',
      modelId: 'vendor:model:latest',
      api: 'evaluation',
      contractValid: true,
      expectedAnswersMatch: false,
      elapsedMs: 23,
      usage: null,
      warnings: ['unsupported'],
    };
    const testProviderOperation = vi.fn().mockResolvedValue(result);
    const view = renderScreen(
      makeClient({
        getModelSelection: vi.fn().mockResolvedValue(selection),
        patchModelSelection,
        testProviderOperation,
      }),
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Instincts'));
    for (let index = 0; index < 6; index++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      view.stdin.write('\u001B[B');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('[generation]'));
    view.stdin.write('a');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('openai-primary'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Latest'));
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
    view.stdin.write('\u001B[1;2A');
    await vi.waitFor(() =>
      expect(selection.instincts[0]?.api).toBe('evaluation'),
    );
    expect(selection.instincts[1]).toMatchObject({
      api: 'generation',
      attemptTimeoutMs: 900,
      providerOptions: { openai: { mode: 'original' } },
    });
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('API: evaluation'),
    );
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
    expect(testProviderOperation).not.toHaveBeenCalled();
    view.stdin.write('t');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('may incur charges'),
    );
    expect(testProviderOperation).not.toHaveBeenCalled();
    view.stdin.write('y');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('expected answers do not match'),
    );
    expect(view.lastFrame()).toContain('input unknown');
    expect(view.lastFrame()).toContain('not accuracy certification');
    expect(testProviderOperation).toHaveBeenCalledWith(
      'openai-primary',
      {
        modelId: 'vendor:model:latest',
        api: 'evaluation',
        providerOptions: undefined,
        timeoutMs: 2500,
      },
      expect.any(AbortSignal),
    );
    let finish!: (value: InstinctOperationTestResult) => void;
    testProviderOperation.mockImplementationOnce(
      () =>
        new Promise<InstinctOperationTestResult>((resolve) => {
          finish = resolve;
        }),
    );
    view.stdin.write('t');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('may incur charges'),
    );
    view.stdin.write('y');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Esc cancels'));
    const signal = testProviderOperation.mock.calls[1]?.[2] as AbortSignal;
    view.stdin.write('\u001B');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('API: evaluation'),
    );
    expect(signal.aborted).toBe(true);
    finish({ ...result, diagnostic: 'late result must be ignored' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.lastFrame()).not.toContain('late result');
    expect(view.lastFrame()).not.toContain('Synthetic test:');
    expect(testProviderOperation).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it.each([
    { purpose: 'consult', label: 'Consult', index: 1 },
    { purpose: 'instincts', label: 'Instincts', index: 6 },
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
      for (let i = 0; i < index; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        view.stdin.write('\u001B[B');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      view.stdin.write('\r');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('No models'));
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
