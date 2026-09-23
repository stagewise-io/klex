export type { TelemetrySpanProcessor } from './span-processor';
export { createTelemetrySpanProcessor } from './span-processor';
export type {
  TelemetryManager,
  TelemetryManagerDependencies,
} from './telemetry-manager';
export { createTelemetryManager, otlpMinLevel } from './telemetry-manager';
