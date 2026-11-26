import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

import { type SoulFailure, soulFailureSchema } from './failure';

const stateSchema = z
  .object({
    failure: soulFailureSchema.safeExtend({}).passthrough().nullable(),
  })
  .passthrough();

export const SOUL_STATE_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'soul-extension-state',
  relativePath: 'extensions/io.stagewise/soul/state.json',
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: KLEX_VERSION,
  versions: [{ version: 1, schema: stateSchema }],
  migrations: [],
};

export async function readSoulState(directory: string) {
  return readCurrentJsonStore<z.infer<typeof stateSchema>>(
    join(directory, 'state.json'),
    SOUL_STATE_STORE_DEFINITION,
    directory,
  );
}

export async function writeSoulFailure(
  directory: string,
  failure: SoulFailure | null,
) {
  const previous = await readSoulState(directory);
  if (!previous && failure === null) return;
  await writeJsonStoreDocument(
    join(directory, 'state.json'),
    SOUL_STATE_STORE_DEFINITION,
    { ...previous?.payload, failure },
    KLEX_VERSION,
    previous?.metadata,
  );
}
