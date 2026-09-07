import { z } from 'zod';

import type { JsonStoreDefinition } from '@/local-data';

import { klexConfigSchema } from './types';

const klexConfigStorageSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const result = klexConfigSchema.safeParse(value);
    if (result.success) return;
    for (const issue of result.error.issues) {
      context.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }
  });

export const CONFIG_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'config',
  relativePath: 'config.json',
  required: true,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.3.0',
  legacySchemaVersion: 1,
  versions: [{ version: 1, schema: klexConfigStorageSchema }],
  migrations: [],
};
