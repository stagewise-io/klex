import { z } from 'zod';

import type { JsonStoreDefinition } from '@/local-data';

import {
  migrateLegacyKlexConfig,
  parseCurrentStoredKlexConfig,
  parseLegacyKlexConfig,
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
    parseCurrentStoredKlexConfig(value);
    return;
  }
  parseLegacyKlexConfig(value);
});
const currentConfigStorageSchema = preservingSchema((value) => {
  parseCurrentStoredKlexConfig(value);
});

export const CONFIG_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'config',
  relativePath: 'config.json',
  required: true,
  schemaVersion: 2,
  compatibilityVersion: 2,
  minimumKlexVersion: '0.3.0',
  legacySchemaVersion: 1,
  versions: [
    { version: 1, schema: legacyConfigStorageSchema },
    { version: 2, schema: currentConfigStorageSchema },
  ],
  migrations: [
    {
      from: 1,
      to: 2,
      name: 'unify-model-provider-registry',
      up: (value) =>
        value.configVersion === 2
          ? parseCurrentStoredKlexConfig(value)
          : migrateLegacyKlexConfig(value),
    },
  ],
};
