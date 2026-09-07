import type { Client, InStatement, ResultSet } from '@libsql/client';
import type { z } from 'zod';

export interface LocalDataMetadata {
  store: string;
  schemaVersion: number;
  compatibilityVersion: number;
  minimumKlexVersion: string;
  writtenByKlexVersion: string;
}

export interface JsonStoreVersion {
  version: number;
  schema: z.ZodType<unknown>;
}

export interface JsonMigration {
  from: number;
  to: number;
  name: string;
  up: (
    value: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface SqliteMigrationDatabase {
  execute(statement: InStatement): Promise<ResultSet>;
}

export interface SqliteMigration {
  from: number;
  to: number;
  name: string;
  up: (database: SqliteMigrationDatabase) => Promise<void>;
}

interface StoreDefinitionBase {
  id: string;
  relativePath: string;
  required: boolean;
  schemaVersion: number;
  compatibilityVersion: number;
  minimumKlexVersion: string;
}

export interface JsonStoreDefinition extends StoreDefinitionBase {
  kind: 'json';
  versions: readonly JsonStoreVersion[];
  migrations: readonly JsonMigration[];
}

export interface SqliteStoreDefinition extends StoreDefinitionBase {
  kind: 'sqlite';
  createIfMissing: boolean;
  initSql: string;
  migrations: readonly SqliteMigration[];
  validate?: (client: Client) => Promise<void>;
}

export type LocalDataStoreDefinition =
  | JsonStoreDefinition
  | SqliteStoreDefinition;

export interface StoreInspection {
  definition: LocalDataStoreDefinition;
  path: string;
  exists: boolean;
  metadata?: LocalDataMetadata;
  needsMigration: boolean;
  needsInitialization: boolean;
}
