import type { JsonMigration } from '@/local-data';

import {
  klexConfigV4Schema,
  storedKlexConfigV2Schema,
} from './config-contracts';

export function dropLegacyTelemetryConfig(input: unknown) {
  return klexConfigV4Schema.parse(storedKlexConfigV2Schema.parse(input));
}

export const configV3V4: JsonMigration = {
  from: 3,
  to: 4,
  name: 'drop-telemetry-config',
  up: (value) => dropLegacyTelemetryConfig(value),
};
