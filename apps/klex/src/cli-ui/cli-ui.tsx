import { Box, render, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AdminApiClient } from './api-client';
import { AppFrame } from './components/app-frame';
import { UpdateBanner } from './components/update-banner';
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
import { DebugInformationScreen } from './screens/debug-information';
import { HomeScreen } from './screens/home';
import { LogViewerScreen } from './screens/log-viewer';
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
  private readonly dataDirectory: string;
  private readonly logStore: CliUiDependencies['logStore'];
  private readonly dangerousLocalAdminApiPort: number | undefined;
  private readonly updateManager: CliUiDependencies['updateManager'];
  private inkInstance: ReturnType<typeof render> | undefined;
  private terminalCleared = false;

  constructor(deps: CliUiDependencies) {
    this.onQuit = deps.onQuit;
    this.adminApi = deps.adminApi;
    this.dataDirectory = deps.dataDirectory;
    this.logStore = deps.logStore;
    this.dangerousLocalAdminApiPort = deps.dangerousLocalAdminApiPort;
    this.updateManager = deps.updateManager;
  }

  start(): void {
    if (this.inkInstance) return;

    const apiClient = new AdminApiClient(
      'http://klex.local',
      async (input, init) => this.adminApi.handle(new Request(input, init)),
    );

    this.terminalCleared = false;
    this.inkInstance = render(
      <AppRoot
        apiClient={apiClient}
        dataDirectory={this.dataDirectory}
        logStore={this.logStore}
        dangerousLocalAdminApiPort={this.dangerousLocalAdminApiPort}
        onQuit={() => this.requestQuit()}
        updateManager={this.updateManager}
      />,
      {
        exitOnCtrlC: false,
      },
    );

    // Bridge Ink's exit (Ctrl+C via exitOnCtrlC, or unmount from 'q')
    // to the host process shutdown handler.
    const instance = this.inkInstance;
    if (instance) {
      instance.waitUntilExit().then(
        () => {
          this.clearTerminal();
          this.onQuit();
        },
        () => {
          this.clearTerminal();
          this.onQuit();
        },
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
    this.clearTerminal();
  }

  /** Called when the user presses 'q'. Unmounts Ink; waitUntilExit
   * then resolves and triggers onQuit (process shutdown). */
  private requestQuit(): void {
    try {
      this.inkInstance?.unmount();
    } catch {
      // If unmount fails, fall back to direct process shutdown.
      this.clearTerminal();
      this.onQuit();
    }
  }

  private clearTerminal(): void {
    if (this.terminalCleared) return;
    this.terminalCleared = true;
    process.stdout.write('\u001b[2J\u001b[3J\u001b[H');
  }
}

function AppRoot({
  apiClient,
  dataDirectory,
  logStore,
  dangerousLocalAdminApiPort,
  onQuit,
  updateManager,
}: {
  apiClient: AdminApiClient;
  dataDirectory: string;
  logStore: CliUiDependencies['logStore'];
  dangerousLocalAdminApiPort: number | undefined;
  onQuit: () => void;
  updateManager: CliUiDependencies['updateManager'];
}) {
  const navigation = useNavigationState();
  const globalStatus = useGlobalStatus(apiClient);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const quitConfirmationExpiresAt = useRef(0);
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
  const requestQuit = useCallback(async () => {
    if (updateManager?.getState().status === 'installing') {
      if (Date.now() > quitConfirmationExpiresAt.current) {
        quitConfirmationExpiresAt.current = Date.now() + 5_000;
        pushToast(
          'An update is installing. Press q or Ctrl+C again within 5 seconds to cancel it and quit.',
          'warning',
        );
        return;
      }
      await updateManager.cancelInstall();
    }
    onQuit();
  }, [onQuit, pushToast, updateManager]);

  return (
    <NavigationContext.Provider value={navigation}>
      <ToastContext.Provider value={{ toasts, pushToast, dismissToast }}>
        <ScreenMetaProvider>
          <TextInputActiveProvider>
            <GlobalQuitHandler onQuit={() => void requestQuit()} />
            <FrameLayout
              apiClient={apiClient}
              dataDirectory={dataDirectory}
              logStore={logStore}
              navigation={navigation}
              sessions={globalStatus.sessions}
              cloud={globalStatus.cloud}
              loading={globalStatus.loading}
              toasts={toasts}
              onDismissToast={dismissToast}
              dangerousLocalAdminApiPort={dangerousLocalAdminApiPort}
              onRefreshGlobal={globalStatus.refresh}
              updateManager={updateManager}
            />
          </TextInputActiveProvider>
        </ScreenMetaProvider>
      </ToastContext.Provider>
    </NavigationContext.Provider>
  );
}

function GlobalQuitHandler({ onQuit }: { onQuit: () => void }) {
  const { active } = useTextInputActive();
  useInput((input, key) => {
    // Ctrl+C always requests shutdown. 'q' quits only when not typing.
    if (
      (key.ctrl && input === 'c') ||
      (input.toLowerCase() === 'q' && !active)
    ) {
      onQuit();
    }
  });
  return null;
}

function FrameLayout({
  apiClient,
  dataDirectory,
  logStore,
  navigation,
  sessions,
  cloud,
  loading,
  toasts,
  onDismissToast,
  dangerousLocalAdminApiPort,
  onRefreshGlobal,
  updateManager,
}: {
  apiClient: AdminApiClient;
  dataDirectory: string;
  logStore: CliUiDependencies['logStore'];
  navigation: NavigationContextValue;
  sessions: import('./api-client').SessionInfo[];
  cloud: import('./api-client').CloudStatus | null;
  loading: boolean;
  toasts: Toast[];
  onDismissToast: (id: number) => void;
  dangerousLocalAdminApiPort: number | undefined;
  onRefreshGlobal: () => void;
  updateManager: CliUiDependencies['updateManager'];
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
      toasts={toasts}
      onDismissToast={onDismissToast}
      updateBanner={
        updateManager ? (
          <UpdateBanner
            activeSessionCount={
              sessions.filter(
                (session) =>
                  session.runtimeState === 'running' ||
                  session.status === 'running',
              ).length
            }
            inputBlocked={meta.keys.some(({ key }) =>
              ['n', 'u'].includes(key.toLowerCase()),
            )}
            manager={updateManager}
          />
        ) : undefined
      }
    >
      <ScreenRouter
        apiClient={apiClient}
        dataDirectory={dataDirectory}
        logStore={logStore}
        navigation={navigation}
        sessions={sessions}
        cloud={cloud}
        dangerousLocalAdminApiPort={dangerousLocalAdminApiPort}
        onRefreshGlobal={onRefreshGlobal}
      />
    </AppFrame>
  );
}

function ScreenRouter({
  apiClient,
  dataDirectory,
  logStore,
  navigation,
  sessions,
  cloud,
  dangerousLocalAdminApiPort,
  onRefreshGlobal,
}: {
  apiClient: AdminApiClient;
  dataDirectory: string;
  logStore: CliUiDependencies['logStore'];
  navigation: NavigationContextValue;
  sessions: import('./api-client').SessionInfo[];
  cloud: import('./api-client').CloudStatus | null;
  dangerousLocalAdminApiPort: number | undefined;
  onRefreshGlobal: () => void;
}) {
  switch (navigation.current) {
    case 'home':
      return (
        <HomeScreen
          apiClient={apiClient}
          sessions={sessions}
          cloud={cloud}
          dangerousLocalAdminApiPort={dangerousLocalAdminApiPort}
          onRefreshGlobal={onRefreshGlobal}
          onOpenSettings={() => navigation.navigate('settings')}
          onOpenUsage={() => navigation.navigate('usage')}
        />
      );
    case 'settings':
      return (
        <SettingsScreen
          dataDirectory={dataDirectory}
          onOpenProviders={() => navigation.navigate('providers')}
          onOpenCloud={() => navigation.navigate('cloud')}
          onOpenMcp={() => navigation.navigate('mcp-servers')}
          onOpenModelSelection={() => navigation.navigate('model-selection')}
          onOpenTelemetry={() => navigation.navigate('telemetry')}
          onOpenDebugInformation={() =>
            navigation.navigate('debug-information')
          }
          onOpenLogs={() => navigation.navigate('logs')}
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
    case 'debug-information':
      return (
        <DebugInformationScreen
          dataDirectory={dataDirectory}
          cloud={cloud}
          dangerousLocalAdminApiPort={dangerousLocalAdminApiPort}
          onBack={() => navigation.goBack()}
        />
      );
    case 'logs':
      return (
        <LogViewerScreen
          logStore={logStore}
          onBack={() => navigation.goBack()}
        />
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
          dangerousLocalAdminApiPort={dangerousLocalAdminApiPort}
          onRefreshGlobal={onRefreshGlobal}
          onOpenSettings={() => navigation.navigate('settings')}
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
