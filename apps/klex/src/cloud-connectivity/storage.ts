import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

/** Subdirectory within the working directory that holds identity and enrollment files. */
export const IDENTITY_DIR = 'identity';

const identityMetadataSchema = z
  .object({
    kid: z.string(),
    algorithm: z.literal('EdDSA'),
    createdAt: z.string(),
  })
  .passthrough();

const enrollmentSchema = z
  .object({
    clientId: z.string().nullable(),
    enrolledAt: z.string().nullable(),
    kid: z.string(),
  })
  .passthrough();

export const CLOUD_IDENTITY_METADATA_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'cloud-identity-metadata',
  relativePath: `${IDENTITY_DIR}/metadata.json`,
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.3.0',
  versions: [{ version: 1, schema: identityMetadataSchema }],
  migrations: [],
};

export const CLOUD_ENROLLMENT_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'cloud-enrollment',
  relativePath: `${IDENTITY_DIR}/enrollment.json`,
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.3.0',
  versions: [{ version: 1, schema: enrollmentSchema }],
  migrations: [],
};

export async function readCloudJsonFile<T extends object>(
  dataDirectory: string,
  definition: JsonStoreDefinition,
): Promise<T | undefined> {
  return (
    await readCurrentJsonStore<T>(
      join(dataDirectory, definition.relativePath),
      definition,
      dataDirectory,
    )
  )?.payload;
}

/** Atomically write a versioned JSON file with restrictive permissions. */
export async function writeSecureJsonFile<T extends object>(
  dataDirectory: string,
  definition: JsonStoreDefinition,
  data: T,
): Promise<void> {
  const filePath = join(dataDirectory, definition.relativePath);
  const existing = await readCurrentJsonStore<Record<string, unknown>>(
    filePath,
    definition,
    dataDirectory,
  );
  await writeJsonStoreDocument(
    filePath,
    definition,
    { ...existing?.payload, ...data },
    KLEX_VERSION,
    existing?.metadata,
  );
}
