import { Box, render, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminApiClient } from './api-client';
import { AppFrame } from './components/app-frame';
import { ToastStack } from './components/toast';
import { useGlobalStatus } from './hooks/use-global-status';
import {
  NavigationContext,
  type NavigationContextValue,
  useNavigationState,
} from './hooks/use-navigation';
import { ScreenMetaProvider, useScreenMeta } from './hooks/use-screen-meta';
import {
  TextInputActiveProvider,
  useTextInputActive,
} from './hooks/use-text-input-active';
import { type Toast, ToastContext } from './hooks/use-toast';
import { MenuKeys, useMenuInput } from './menu-keys';
import { CloudScreen } from './screens/cloud';
import { HomeScreen } from './screens/home';
import { McpScreen } from './screens/mcp';
import { ModelSelectionScreen } from './screens/model-selection';
import { ProvidersScreen } from './screens/providers';
import { SettingsScreen } from './screens/settings';
import { UsageScreen } from './screens/usage';
import type { CliUiDependencies } from './types';

export interface CliUi {
  start(): void;
  close(): void;
}

export function createCliUi(deps: CliUiDependencies): CliUi {
  return new CliUiModule(deps);
}

class CliUiModule implements CliUi {
  private readonly onQuit: () => void;
  private readonly adminApi: CliUiDependencies['adminApi'];
  private readonly dangerousLocalAdminApiPort: number | undefined;
  private inkInstance: ReturnType<typeof render> | undefined;

  constructor(deps: CliUiDependencies) {
    this.onQuit = deps.onQuit;
    this.adminApi = deps.adminApi;
    this.dangerousLocalAdminApiPort = deps.dangerousLocalAdminApiPort;
  }

  start(): void {
    if (this.inkInstance) return;

    const apiClient = new AdminApiClient(
      'http://klex.local',
      async (input, init) => this.adminApi.handle(new Request(input, init)),
    );

    this.inkInstance = render(
      <AppRoot
        apiClient={apiClient}
        dangerousLocalAdminApiPort={this.dangerousLocalAdminApiPort}
        onQuit={() => this.requestQuit()}
      />,
      {
        exitOnCtrlC: true,
      },
    );

    // Bridge Ink's exit (Ctrl+C via exitOnCtrlC, or unmount from 'q')
    // to the host process shutdown handler.
    const instance = this.inkInstance;
    if (instance) {
      instance.waitUntilExit().then(
        () => this.onQuit(),
        () => this.onQuit(),
      );
    }
  }

  close(): void {
    try {
      this.inkInstance?.unmount();
    } catch {
      // Best-effort — the React tree may already be torn down.
    }
    this.inkInstance = undefined;
  }

  /** Called when the user presses 'q'. Unmounts Ink; waitUntilExit
   * then resolves and triggers onQuit (process shutdown). */
  private requestQuit(): void {
    try {
      this.inkInstance?.unmount();
    } catch {
      // If unmount fails, fall back to direct process shutdown.
      this.onQuit();
    }
  }
}

function AppRoot({
  apiClient,
  dangerousLocalAdminApiPort,
  onQuit,
}: {
  apiClient: AdminApiClient;
  dangerousLocalAdminApiPort: number | undefined;
  onQuit: () => void;
}) {
  const navigation = useNavigationState();
  const globalStatus = useGlobalStatus(apiClient);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const pushToast = useCallback(
    (message: string, level: Toast['level'] = 'info') => {
      setToasts((prev) => [
        ...prev,
        { id: Date.now() + Math.random(), message, level },
      ]);
    },
    [],
  );
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <NavigationContext.Provider value={navigation}>
      <ToastContext.Provider value={{ toasts, pushToast, dismissToast }}>
        <ScreenMetaProvider>
          <TextInputActiveProvider>
            <GlobalQuitHandler onQuit={onQuit} />
            <FrameLayout
              apiClient={apiClient}
              navigation={navigation}
              sessions={globalStatus.sessions}
              cloud={globalStatus.cloud}
              loading={globalStatus.loading}
              toastCount={toasts.length}
              dangerousLocalAdminApiPort={dangerousLocalAdminApiPort}
              onRefreshGlobal={globalStatus.refresh}
            />
          </TextInputActiveProvider>
        </ScreenMetaProvider>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </ToastContext.Provider>
    </NavigationContext.Provider>
  );
}

function GlobalQuitHandler({ onQuit }: { onQuit: () => void }) {
  const { active } = useTextInputActive();
  useInput((input) => {
    // Ctrl+C is handled natively by Ink via exitOnCtrlC: true.
    // 'q' quits only when not typing in a text input.
    if (input.toLowerCase() === 'q' && !active) {
      onQuit();
    }
  });
  return null;
}

function FrameLayout({
  apiClient,
  navigation,
  sessions,
  cloud,
  loading,
  toastCount,
  dangerousLocalAdminApiPort,
  onRefreshGlobal,
}: {
  apiClient: AdminApiClient;
  navigation: NavigationContextValue;
  sessions: import('./api-client').SessionInfo[];
  cloud: import('./api-client').CloudStatus | null;
  loading: boolean;
  toastCount: number;
  dangerousLocalAdminApiPort: number | undefined;
  onRefreshGlobal: () => void;
}) {
  const { meta } = useScreenMeta();

  const allKeys = useMemo(
    () => [...meta.keys, { key: 'q', label: 'Quit' }],
    [meta.keys],
  );

  return (
    <AppFrame
      screenTitle={meta.title}
      breadcrumb={meta.breadcrumb}
      keys={allKeys}
      sessions={sessions}
      cloud={cloud}
      loading={loading}
      toastCount={toastCount}
      dangerousLocalAdminApiPort={dangerousLocalAdminApiPort}
    >
      <ScreenRouter
        apiClient={apiClient}
        navigation={navigation}
        sessions={sessions}
        cloud={cloud}
        onRefreshGlobal={onRefreshGlobal}
      />
    </AppFrame>
  );
}

function ScreenRouter({
  apiClient,
  navigation,
  sessions,
  cloud,
  onRefreshGlobal,
}: {
  apiClient: AdminApiClient;
  navigation: NavigationContextValue;
  sessions: import('./api-client').SessionInfo[];
  cloud: import('./api-client').CloudStatus | null;
  onRefreshGlobal: () => void;
}) {
  switch (navigation.current) {
    case 'home':
      return (
        <HomeScreen
          apiClient={apiClient}
          sessions={sessions}
          cloud={cloud}
          onRefreshGlobal={onRefreshGlobal}
          onOpenSettings={() => navigation.navigate('settings')}
          onOpenCloud={() => navigation.navigate('cloud')}
          onOpenUsage={() => navigation.navigate('usage')}
        />
      );
    case 'settings':
      return (
        <SettingsScreen
          onOpenProviders={() => navigation.navigate('providers')}
          onOpenMcp={() => navigation.navigate('mcp-servers')}
          onOpenModelSelection={() => navigation.navigate('model-selection')}
          onOpenTelemetry={() => navigation.navigate('telemetry')}
          onBack={() => navigation.goBack()}
        />
      );
    case 'providers':
      return (
        <ProvidersScreen
          apiClient={apiClient}
          onBack={() => navigation.goBack()}
        />
      );
    case 'mcp-servers':
      return (
        <McpScreen apiClient={apiClient} onBack={() => navigation.goBack()} />
      );
    case 'cloud':
      return (
        <CloudScreen apiClient={apiClient} onBack={() => navigation.goBack()} />
      );
    case 'model-selection':
      return (
        <ModelSelectionScreen
          apiClient={apiClient}
          onBack={() => navigation.goBack()}
        />
      );
    case 'usage':
      return (
        <UsageScreen apiClient={apiClient} onBack={() => navigation.goBack()} />
      );
    case 'telemetry':
      return (
        <ComingSoon title="Telemetry" onBack={() => navigation.goBack()} />
      );
    default:
      return (
        <HomeScreen
          apiClient={apiClient}
          sessions={sessions}
          cloud={cloud}
          onRefreshGlobal={onRefreshGlobal}
          onOpenSettings={() => navigation.navigate('settings')}
          onOpenCloud={() => navigation.navigate('cloud')}
          onOpenUsage={() => navigation.navigate('usage')}
        />
      );
  }
}

function ComingSoon({ title, onBack }: { title: string; onBack: () => void }) {
  const { setMeta } = useScreenMeta();
  useEffect(() => {
    setMeta({
      title,
      breadcrumb: ['Home', 'Settings'],
      keys: [{ key: 'esc', label: 'Back' }],
    });
  }, [setMeta, title]);
  useMenuInput({ [MenuKeys.Back]: onBack });
  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text dimColor>This screen is not yet implemented.</Text>
      </Box>
    </Box>
  );
}
