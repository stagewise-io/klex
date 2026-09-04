export type Screen =
  | 'home'
  | 'settings'
  | 'providers'
  | 'mcp-servers'
  | 'cloud'
  | 'model-selection'
  | 'telemetry'
  | 'usage';

export interface CliUiDependencies {
  logging: import('@stagewise/logger').RootLogger;
  onQuit: () => void;
  adminApi: Pick<import('@/admin-api').AdminApi, 'handle'>;
  dangerousLocalAdminApiPort: number | undefined;
}
