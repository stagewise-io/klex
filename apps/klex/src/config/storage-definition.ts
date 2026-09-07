import { z } from 'zod';

import type { JsonStoreDefinition } from '@/local-data';

import { klexConfigSchema } from './types';

const klexConfigStorageSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => klexConfigSchema.safeParse(value).success, {
    message: 'Stored Klex configuration is invalid',
  });

export const CONFIG_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'config',
  relativePath: 'config.json',
  required: true,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.3.0',
  versions: [{ version: 1, schema: klexConfigStorageSchema }],
  migrations: [],
};
