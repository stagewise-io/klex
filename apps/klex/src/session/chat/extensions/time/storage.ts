import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

export const TIMEZONE_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'time-extension-timezone',
  relativePath: 'extensions/io.stagewise/time/timezone.json',
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.4.0',
  legacySchemaVersion: 1,
  versions: [
    {
      version: 1,
      schema: z.object({ timezone: z.string() }).passthrough(),
    },
  ],
  migrations: [],
};

export async function readTimezoneStore(
  dataDirectory: string,
): Promise<string | undefined> {
  const document = await readCurrentJsonStore<{ timezone: string }>(
    join(dataDirectory, TIMEZONE_STORE_DEFINITION.relativePath),
    TIMEZONE_STORE_DEFINITION,
    dataDirectory,
  );
  return document?.payload.timezone;
}

export async function writeTimezoneStore(
  dataDirectory: string,
  timezone: string,
): Promise<void> {
  const path = join(dataDirectory, TIMEZONE_STORE_DEFINITION.relativePath);
  const existing = await readCurrentJsonStore<Record<string, unknown>>(
    path,
    TIMEZONE_STORE_DEFINITION,
    dataDirectory,
  );
  await writeJsonStoreDocument(
    path,
    TIMEZONE_STORE_DEFINITION,
    { ...existing?.payload, timezone },
    KLEX_VERSION,
    existing?.metadata,
  );
}
