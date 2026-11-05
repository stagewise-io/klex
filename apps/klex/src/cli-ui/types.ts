export type Screen =
  | 'home'
  | 'settings'
  | 'soul'
  | 'providers'
  | 'mcp-servers'
  | 'cloud'
  | 'model-selection'
  | 'debug-information'
  | 'logs'
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
  /** Persistent banner shown while telemetry is exporting. */
  telemetryWarning: import('@/telemetry-config').TelemetryWarning | undefined;
  /** Enrollment succeeded during this launch; show the setup handoff on Home. */
  cloudEnrollmentCompleted?: boolean;
  updateManager?: import('@/self-update').UpdateManager;
  /** Product-analytics hook for the Cloud screen enrollment flow. */
  trackEnrollment?: import('@/product-analytics').TrackEnrollment;
}
