export type Screen =
  | 'home'
  | 'settings'
  | 'providers'
  | 'mcp-servers'
  | 'cloud'
  | 'model-selection'
  | 'debug-information'
  | 'logs'
  | 'telemetry'
  | 'usage'
  | 'god-messages'
  | 'agent-identity';

export interface CliUiDependencies {
  logging: import('@stagewise/logger').RootLogger;
  onQuit: () => void;
  adminApi: Pick<import('@/admin-api').AdminApi, 'handle'>;
  dataDirectory: string;
  logStore: import('@/log-store').LogStore;
  dangerousLocalAdminApiPort: number | undefined;
}
