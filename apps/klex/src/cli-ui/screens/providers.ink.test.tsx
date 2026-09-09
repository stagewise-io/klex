import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminApiClient,
  ProviderInfo,
  ProviderTypeInfo,
} from '../api-client';
import { GlobalFooter } from '../components/global-footer';
import { ScreenMetaProvider, useScreenMeta } from '../hooks/use-screen-meta';
import { TextInputActiveProvider } from '../hooks/use-text-input-active';
import { ToastContext } from '../hooks/use-toast';
import { ProvidersScreen } from './providers';

const type: ProviderTypeInfo = {
  type: 'google-vertex',
  displayName: 'Test Provider',
  description: 'Test transport',
  capabilities: {
    modelDiscovery: true,
    connectivityTest: true,
    customModels: true,
  },
  settingsSchema: {
    type: 'object',
    properties: {
      authMode: {
        type: 'string',
        enum: ['api-key', 'adc'],
        default: 'api-key',
      },
      apiKey: { type: 'string', writeOnly: true, format: 'password' },
    },
    required: ['authMode', 'apiKey'],
  },
};

function provider(removeAvailable = true): ProviderInfo {
  return {
    id: 'test-primary',
    type: 'google-vertex',
    settings: { authMode: 'api-key', apiKey: { configured: true } },
    metadata: type,
    operations: {
      update: { available: true },
      remove: removeAvailable
        ? { available: true }
        : {
            available: false,
            code: 'referential_integrity',
            message: 'Provider is selected for chat',
            remediation: 'Remove it from model selection first.',
          },
    },
  };
}

function makeClient(
  instances: ProviderInfo[],
  overrides: Partial<AdminApiClient> = {},
): AdminApiClient {
  return {
    getProviders: vi.fn().mockResolvedValue({ providers: instances }),
    getProviderTypes: vi.fn().mockResolvedValue({ providerTypes: [type] }),
    getKnownModels: vi.fn().mockResolvedValue({ models: [] }),
    updateProvider: vi.fn().mockResolvedValue({ ok: true }),
    testProvider: vi.fn().mockResolvedValue({ latencyMs: 12 }),
    ...overrides,
  } as unknown as AdminApiClient;
}

function TestFooter() {
  const { meta } = useScreenMeta();
  return (
    <GlobalFooter
      keys={meta.keys}
      sessions={[]}
      cloud={null}
      loading={false}
      toastCount={0}
    />
  );
}

function renderScreen(client: AdminApiClient) {
  return render(
    <ScreenMetaProvider>
      <TextInputActiveProvider>
        <ToastContext.Provider
          value={{ toasts: [], pushToast: vi.fn(), dismissToast: vi.fn() }}
        >
          <ProvidersScreen apiClient={client} onBack={vi.fn()} />
        </ToastContext.Provider>
        <TestFooter />
      </TextInputActiveProvider>
    </ScreenMetaProvider>,
  );
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

describe('ProvidersScreen', () => {
  it('groups and sorts provider types into a navigable list', async () => {
    const providerTypes: ProviderTypeInfo[] = [
      {
        ...type,
        type: 'ollama',
        displayName: 'Ollama',
        description: 'Local models',
      },
      {
        ...type,
        type: 'amazon-bedrock',
        displayName: 'Amazon Bedrock',
        description: 'AWS models',
      },
      {
        ...type,
        type: 'openai',
        displayName: 'OpenAI',
        description: 'OpenAI models',
      },
    ];
    const view = renderScreen(
      makeClient([], {
        getProviderTypes: vi.fn().mockResolvedValue({ providerTypes }),
      }),
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('No providers'));
    view.stdin.write('a');
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('Add a model provider');
      expect(frame).toContain('Direct APIs · OpenAI');
      expect(frame).toContain('Cloud platforms · Amazon Bedrock');
      expect(frame).toContain('Local · Ollama');
      expect(frame).not.toContain('█');
      expect(frame.indexOf('Direct APIs · OpenAI')).toBeLessThan(
        frame.indexOf('Cloud platforms · Amazon Bedrock'),
      );
      expect(frame.indexOf('Cloud platforms · Amazon Bedrock')).toBeLessThan(
        frame.indexOf('Local · Ollama'),
      );
    });
    const initialFrame = view.lastFrame() ?? '';
    const listTop = initialFrame.indexOf('╭');
    const lineCount = initialFrame.split('\n').length;
    view.stdin.write('\u001B[B');
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('AWS models');
      expect(frame.indexOf('╭')).toBe(listTop);
      expect(frame.split('\n')).toHaveLength(lineCount);
    });
    view.unmount();
  });

  it('accepts, masks, and submits a direct secret value', async () => {
    const canAddProvider = vi.fn().mockResolvedValue({ ok: true });
    const createProvider = vi.fn().mockResolvedValue({ ok: true });
    const view = renderScreen(
      makeClient([], { canAddProvider, createProvider }),
    );
    await vi.waitFor(() => expect(view.lastFrame()).toContain('No providers'));
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Test Provider'));
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Instance ID');
      expect(view.lastFrame()).toContain('google-vertex');
    });
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Authentication'),
    );
    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Instance ID'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Authentication'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Step 3 of 3 · API Key');
      expect(view.lastFrame()).toContain('Required');
      expect(view.lastFrame()).toContain(
        'The API credential issued by this provider. Paste the key directly',
      );
      expect(view.lastFrame()).toContain(
        '$' + '{env:VARIABLE_NAME}. It is hidden on screen.',
      );
      expect(view.lastFrame()).toContain('╭');
    });
    await typeText(view, 'secret');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('******'));
    expect(view.lastFrame()).not.toContain('secret');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(createProvider).toHaveBeenCalledWith({
        id: 'google-vertex',
        type: 'google-vertex',
        settings: { authMode: 'api-key', apiKey: 'secret' },
      }),
    );
    expect(canAddProvider).toHaveBeenCalledWith('google-vertex', {
      authMode: 'api-key',
      apiKey: 'secret',
    });
    view.unmount();
  });

  it('omits blank optional Codex settings when saving', async () => {
    const codexType: ProviderTypeInfo = {
      ...type,
      type: 'chatgpt-codex-subscription',
      displayName: 'ChatGPT Codex Subscription',
      settingsSchema: {
        type: 'object',
        properties: {
          codexExecutable: { type: 'string', default: 'codex' },
          authFile: { type: 'string' },
          baseUrl: { type: 'string', format: 'uri' },
          testModelId: { type: 'string', default: 'gpt-5-codex' },
        },
      },
    };
    const canAddProvider = vi.fn().mockResolvedValue({ ok: true });
    const createProvider = vi.fn().mockResolvedValue({ ok: true });
    const view = renderScreen(
      makeClient([], {
        getProviderTypes: vi.fn().mockResolvedValue({
          providerTypes: [codexType],
        }),
        canAddProvider,
        createProvider,
      }),
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('No providers'));
    view.stdin.write('a');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('ChatGPT Codex Subscription'),
    );
    view.stdin.write('\r');
    for (const label of [
      'Instance ID',
      'Codex Executable',
      'Auth File',
      'Base URL',
      'Test Model ID',
    ]) {
      await vi.waitFor(() => expect(view.lastFrame()).toContain(label));
      view.stdin.write('\r');
    }

    const expectedSettings = {
      codexExecutable: 'codex',
      testModelId: 'gpt-5-codex',
    };
    await vi.waitFor(() => {
      expect(canAddProvider).toHaveBeenCalledWith(
        'chatgpt-codex-subscription',
        expectedSettings,
      );
      expect(createProvider).toHaveBeenCalledWith({
        id: 'chatgpt-codex-subscription',
        type: 'chatgpt-codex-subscription',
        settings: expectedSettings,
      });
    });
    view.unmount();
  });

  it('omits configured secrets from updates', async () => {
    const updateProvider = vi.fn().mockResolvedValue({ ok: true });
    const view = renderScreen(makeClient([provider()], { updateProvider }));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('test-primary'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Edit settings'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Authentication'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Leave blank to keep'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(updateProvider).toHaveBeenCalledWith('test-primary', {
        settings: { authMode: 'api-key' },
      }),
    );
    view.unmount();
  });

  it('opens provider details without presenting a removal blocker as an action result', async () => {
    const testProvider = vi.fn().mockResolvedValue({
      latencyMs: 42,
      target: 'https://models.example.test',
    });
    const view = renderScreen(makeClient([provider(false)], { testProvider }));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('test-primary'));
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Edit settings');
      expect(view.lastFrame()).toContain('Manage known models');
      expect(view.lastFrame()).toContain('Delete provider instance');
      expect(view.lastFrame()).not.toContain('Removal blocked');
      expect(view.lastFrame()).not.toContain(
        'Remove it from model selection first.',
      );
    });
    view.stdin.write('\u001B[B');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('❯ Test connectivity'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(testProvider).toHaveBeenCalledWith('test-primary');
      expect(view.lastFrame()).toContain('Connected in 42ms');
    });
    view.unmount();
  });

  it('keeps known models on a bounded searchable subpage', async () => {
    const models = Array.from({ length: 12 }, (_, index) => ({
      modelId: `model-${String(index).padStart(2, '0')}`,
      displayName: `Model ${String(index).padStart(2, '0')}`,
      source: index === 11 ? ('manual' as const) : ('discovered' as const),
    }));
    const view = renderScreen(
      makeClient([provider()], {
        getKnownModels: vi.fn().mockResolvedValue({ models }),
      }),
    );

    await vi.waitFor(() => expect(view.lastFrame()).toContain('test-primary'));
    expect(view.lastFrame()).toContain('[Enter]');
    expect(view.lastFrame()).toContain('open its details');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Manage known models'),
    );
    expect(view.lastFrame()).not.toContain('Model 00');

    view.stdin.write('\u001B[B');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('❯ Test connectivity'),
    );
    view.stdin.write('\u001B[B');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('❯ Manage known models'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('Known models');
      expect(frame).toContain('Model 00');
      expect(frame).not.toContain('Model 11');
      expect(frame).toContain('█');
      expect(frame.split('\n').length).toBeLessThan(25);
      expect(frame).toContain('Add manually');
      expect(frame).toContain('Refresh');
      expect(frame).toContain('[Enter] Edit / override');
      expect(frame).not.toContain('[d] Delete override');
    });

    view.stdin.write('/');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Finish search');
      expect(view.lastFrame()).not.toContain('Add manually');
      expect(view.lastFrame()).not.toContain('Refresh');
    });
    await typeText(view, 'mD 11');
    view.stdin.write('\r');
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? '';
      expect(frame).toContain('Model 11');
      expect(frame).not.toContain('Model 00');
      expect(frame.match(/\[Enter\] Edit \/ override/g)).toHaveLength(1);
      expect(frame.match(/\[d\] Delete override/g)).toHaveLength(1);
    });

    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Model ID'));
    view.unmount();
  });
});
