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
  compaction: [],
  memory: [],
  imageVision: [],
  audioListening: [],
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

  it('persists a manual model before selecting it', async () => {
    const createKnownModel = vi.fn().mockResolvedValue({ models: [] });
    const patchModelSelection = vi.fn().mockResolvedValue(emptySelection);
    const view = renderScreen(
      makeClient({ createKnownModel, patchModelSelection }),
    );
    await openModelPicker(view);
    view.stdin.write('\u001B[B');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('❯ Enter a manual model ID'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Native model ID'),
    );
    await typeText(view, 'custom:model:v2');
    view.stdin.write('\r');

    await vi.waitFor(() => {
      expect(createKnownModel).toHaveBeenCalledWith('openai-primary', {
        modelId: 'custom:model:v2',
        displayName: 'custom:model:v2',
      });
      expect(patchModelSelection).toHaveBeenCalledWith({
        chat: [{ providerId: 'openai-primary', modelId: 'custom:model:v2' }],
      });
    });
    expect(createKnownModel.mock.invocationCallOrder[0]).toBeLessThan(
      patchModelSelection.mock.invocationCallOrder[0] ?? 0,
    );
    view.unmount();
  });
});
