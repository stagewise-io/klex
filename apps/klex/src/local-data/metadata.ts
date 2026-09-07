import { z } from 'zod';

import type { LocalDataMetadata, LocalDataStoreDefinition } from './types';

export const localDataMetadataSchema = z
  .object({
    store: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    compatibilityVersion: z.number().int().positive(),
    minimumKlexVersion: z.string().min(1),
    writtenByKlexVersion: z.string().min(1),
  })
  .strict();

export function createLocalDataMetadata(
  definition: LocalDataStoreDefinition,
  klexVersion: string,
  previous?: LocalDataMetadata,
): LocalDataMetadata {
  return {
    store: definition.id,
    schemaVersion: definition.schemaVersion,
    compatibilityVersion: definition.compatibilityVersion,
    minimumKlexVersion:
      previous?.minimumKlexVersion ?? definition.minimumKlexVersion,
    writtenByKlexVersion: klexVersion,
  };
}

export function formatStoreCompatibilityError(
  dataDirectory: string,
  definition: LocalDataStoreDefinition,
  metadata: LocalDataMetadata,
  reason: string,
): string {
  return (
    `Local data store "${definition.id}" at "${dataDirectory}/${definition.relativePath}" ${reason}. ` +
    `Data schema=${metadata.schemaVersion}, compatibility=${metadata.compatibilityVersion}, ` +
    `last written by Klex ${metadata.writtenByKlexVersion}; this binary supports ` +
    `schema=${definition.schemaVersion}, compatibility=${definition.compatibilityVersion}. ` +
    `Use Klex ${metadata.minimumKlexVersion} or newer.`
  );
}

export function assertCompatibleMetadata(
  dataDirectory: string,
  definition: LocalDataStoreDefinition,
  metadata: LocalDataMetadata,
): void {
  if (metadata.store !== definition.id) {
    throw new Error(
      formatStoreCompatibilityError(
        dataDirectory,
        definition,
        metadata,
        `declares store ID "${metadata.store}"`,
      ),
    );
  }
  if (metadata.schemaVersion > definition.schemaVersion) {
    throw new Error(
      formatStoreCompatibilityError(
        dataDirectory,
        definition,
        metadata,
        'was migrated by a newer Klex version',
      ),
    );
  }
  if (metadata.compatibilityVersion > definition.compatibilityVersion) {
    throw new Error(
      formatStoreCompatibilityError(
        dataDirectory,
        definition,
        metadata,
        'requires a newer read/write compatibility level',
      ),
    );
  }
}
