import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminApiClient,
  ProviderInfo,
  ProviderTypeInfo,
} from '../api-client';
import { ScreenMetaProvider } from '../hooks/use-screen-meta';
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

function renderScreen(client: AdminApiClient) {
  return render(
    <ScreenMetaProvider>
      <TextInputActiveProvider>
        <ToastContext.Provider
          value={{ toasts: [], pushToast: vi.fn(), dismissToast: vi.fn() }}
        >
          <ProvidersScreen apiClient={client} onBack={vi.fn()} />
        </ToastContext.Provider>
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
  it('renders conditional schema fields and masks secrets', async () => {
    const view = renderScreen(makeClient([]));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('No providers'));
    view.stdin.write('a');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Test Provider'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Instance ID'));
    await typeText(view, 'instance');
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Authentication'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('API Key *'));
    await typeText(view, 'secret');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('******'));
    expect(view.lastFrame()).not.toContain('secret');
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

  it('shows removal blockers and connectivity state', async () => {
    const testProvider = vi.fn().mockResolvedValue({
      latencyMs: 42,
      target: 'https://models.example.test',
    });
    const view = renderScreen(makeClient([provider(false)], { testProvider }));
    await vi.waitFor(() => expect(view.lastFrame()).toContain('test-primary'));
    view.stdin.write('\r');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Removal blocked');
      expect(view.lastFrame()).toContain(
        'Remove it from model selection first.',
      );
      expect(view.lastFrame()).not.toContain('Delete provider');
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
});
