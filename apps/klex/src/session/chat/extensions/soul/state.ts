import { statSync } from 'node:fs';
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
    failure: soulFailureSchema
      .safeExtend({
        soulVersion: z
          .string()
          .regex(/^\d+:\d+:\d+:\d+$/)
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable(),
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

/** Atomic replacement changes the inode even when the saved text is identical. */
export function readSoulVersion(directory: string): string | null {
  try {
    const stat = statSync(join(directory, 'SOUL.md'), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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
    {
      ...previous?.payload,
      failure:
        failure === null
          ? null
          : { ...failure, soulVersion: readSoulVersion(directory) },
    },
    KLEX_VERSION,
    previous?.metadata,
  );
}
