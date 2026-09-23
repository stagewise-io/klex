import { z } from 'zod';

import type { JsonStoreDefinition } from '@/local-data';

import {
  dropLegacyTelemetryConfig,
  migrateLegacyKlexConfig,
  parseLegacyKlexConfig,
  parseStoredKlexConfig,
  parseStoredKlexConfigV2,
} from './types';

function preservingSchema(
  validate: (value: Record<string, unknown>) => void,
): z.ZodType<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).superRefine((value, context) => {
    try {
      validate(value);
    } catch (error) {
      if (error instanceof z.ZodError) {
        for (const issue of error.issues) {
          context.addIssue({
            code: 'custom',
            path: issue.path,
            message: issue.message,
          });
        }
        return;
      }
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid config',
      });
    }
  });
}

const legacyConfigStorageSchema = preservingSchema((value) => {
  if (value.configVersion === 2) {
    parseStoredKlexConfigV2(value);
    return;
  }
  parseLegacyKlexConfig(value);
});
const v2ConfigStorageSchema = preservingSchema((value) => {
  parseStoredKlexConfigV2(value);
});
const currentConfigStorageSchema = preservingSchema((value) => {
  parseStoredKlexConfig(value);
});

export const CONFIG_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'config',
  relativePath: 'config.json',
  required: true,
  schemaVersion: 4,
  compatibilityVersion: 6,
  minimumKlexVersion: '0.9.2',
  legacySchemaVersion: 1,
  versions: [
    { version: 1, schema: legacyConfigStorageSchema },
    { version: 2, schema: v2ConfigStorageSchema },
    // Schema 3 renamed telemetry levels; it shares the v2 shape.
    { version: 3, schema: v2ConfigStorageSchema },
    { version: 4, schema: currentConfigStorageSchema },
  ],
  migrations: [
    {
      from: 1,
      to: 2,
      name: 'unify-model-provider-registry',
      up: (value) =>
        value.configVersion === 2
          ? parseStoredKlexConfigV2(value)
          : migrateLegacyKlexConfig(value),
    },
    {
      from: 2,
      to: 3,
      // Historical step. Telemetry levels are no longer interpreted, so this
      // step only validates; the 3→4 step removes the field.
      name: 'rename-telemetry-levels',
      up: (value) => parseStoredKlexConfigV2(value),
    },
    {
      from: 3,
      to: 4,
      name: 'drop-telemetry-config',
      up: (value) => dropLegacyTelemetryConfig(value),
    },
  ],
};
