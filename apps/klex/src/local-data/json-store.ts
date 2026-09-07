import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  assertCompatibleMetadata,
  createLocalDataMetadata,
  localDataMetadataSchema,
} from './metadata';
import type { JsonStoreDefinition, LocalDataMetadata } from './types';

export interface JsonStoreDocument<T extends object> {
  metadata: LocalDataMetadata;
  payload: T;
}

export async function readJsonStoreDocument(
  filePath: string,
  definition: JsonStoreDefinition,
  dataDirectory: string,
): Promise<JsonStoreDocument<Record<string, unknown>> | undefined> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw new Error(`Could not read local data store "${definition.id}"`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Local data store "${definition.id}" at "${filePath}" is not valid JSON: ${detail}`,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new Error(
      `Local data store "${definition.id}" at "${filePath}" must be a JSON object`,
    );
  }
  if (!('_klex' in value)) {
    throw new Error(
      `Local data store "${definition.id}" at "${filePath}" is unversioned and unsupported. ` +
        'Create a new agent data directory or restore data written by a compatible Klex version.',
    );
  }

  const metadata = localDataMetadataSchema.parse(value._klex);
  assertCompatibleMetadata(dataDirectory, definition, metadata);
  const { _klex: _metadata, ...payload } = value;
  const version = definition.versions.find(
    (candidate) => candidate.version === metadata.schemaVersion,
  );
  if (!version) {
    throw new Error(
      `Local data store "${definition.id}" has schema ${metadata.schemaVersion}, but this binary has no parser for it`,
    );
  }
  return {
    metadata,
    payload: parseStorePayload(version.schema.parse(payload), definition.id),
  };
}

export async function readCurrentJsonStore<T extends object>(
  filePath: string,
  definition: JsonStoreDefinition,
  dataDirectory: string,
): Promise<JsonStoreDocument<T> | undefined> {
  const document = await readJsonStoreDocument(
    filePath,
    definition,
    dataDirectory,
  );
  if (!document) return undefined;
  if (document.metadata.schemaVersion !== definition.schemaVersion) {
    throw new Error(
      `Local data store "${definition.id}" requires migration before use ` +
        `(schema ${document.metadata.schemaVersion} -> ${definition.schemaVersion})`,
    );
  }
  return document as JsonStoreDocument<T>;
}

export async function writeJsonStoreDocument(
  filePath: string,
  definition: JsonStoreDefinition,
  payload: object,
  klexVersion: string,
  previous?: LocalDataMetadata,
): Promise<LocalDataMetadata> {
  const currentSchema = definition.versions.find(
    (candidate) => candidate.version === definition.schemaVersion,
  );
  if (!currentSchema)
    throw new Error(
      `Missing current schema for local data store "${definition.id}"`,
    );
  const validated = parseStorePayload(
    currentSchema.schema.parse(payload),
    definition.id,
  );
  const metadata = createLocalDataMetadata(definition, klexVersion, previous);
  await writeAtomicJson(filePath, { _klex: metadata, ...validated });
  return metadata;
}

export async function migrateJsonStore(
  filePath: string,
  definition: JsonStoreDefinition,
  document: JsonStoreDocument<Record<string, unknown>>,
  klexVersion: string,
): Promise<void> {
  let payload = document.payload;
  let metadata = document.metadata;
  while (metadata.schemaVersion < definition.schemaVersion) {
    const migration = definition.migrations.find(
      (candidate) => candidate.from === metadata.schemaVersion,
    );
    if (!migration) {
      throw new Error(
        `No migration for local data store "${definition.id}" from schema ${metadata.schemaVersion}`,
      );
    }
    const nextSchema = definition.versions.find(
      (candidate) => candidate.version === migration.to,
    );
    if (!nextSchema)
      throw new Error(`Missing schema ${migration.to} for "${definition.id}"`);
    payload = parseStorePayload(
      nextSchema.schema.parse(await migration.up(payload)),
      definition.id,
    );
    metadata = {
      ...metadata,
      schemaVersion: migration.to,
      compatibilityVersion: definition.compatibilityVersion,
      minimumKlexVersion: definition.minimumKlexVersion,
      writtenByKlexVersion: klexVersion,
    };
    await writeAtomicJson(filePath, { _klex: metadata, ...payload });
  }

  if (metadata.compatibilityVersion < definition.compatibilityVersion) {
    metadata = {
      ...metadata,
      compatibilityVersion: definition.compatibilityVersion,
      minimumKlexVersion: definition.minimumKlexVersion,
      writtenByKlexVersion: klexVersion,
    };
    await writeAtomicJson(filePath, { _klex: metadata, ...payload });
  }
}

async function writeAtomicJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseStorePayload(
  value: unknown,
  storeId: string,
): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`Local data store "${storeId}" payload must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
