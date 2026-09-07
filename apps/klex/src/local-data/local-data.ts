import { join, posix, win32 } from 'node:path';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  checkpointDirectory,
  createCheckpoint,
  finishCheckpoint,
  pruneCheckpoints,
  recoverInterruptedMigration,
  restoreCheckpoint,
} from './checkpoint';
import { migrateJsonStore, readJsonStoreDocument } from './json-store';
import {
  initializeSqliteStore,
  inspectSqliteStore,
  migrateSqliteStore,
} from './sqlite-store';
import type { LocalDataStoreDefinition, StoreInspection } from './types';

export interface LocalData {
  start(): Promise<void>;
  close(): Promise<void>;
  inspect(): Promise<readonly StoreInspection[]>;
}

export interface LocalDataDependencies {
  logging: RootLogger;
  dataDirectory: string;
  klexVersion: string;
  stores: readonly LocalDataStoreDefinition[];
}

export class LocalDataRegistryError extends Error {
  override readonly name = 'LocalDataRegistryError';
}

export function validateLocalDataRegistry(
  stores: readonly LocalDataStoreDefinition[],
): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const store of stores) {
    if (!/^[a-z][a-z0-9-]*$/.test(store.id))
      throw new LocalDataRegistryError(
        `Invalid local-data store ID: ${store.id}`,
      );
    if (ids.has(store.id))
      throw new LocalDataRegistryError(
        `Duplicate local-data store ID: ${store.id}`,
      );
    const normalizedPath = posix.normalize(store.relativePath);
    if (paths.has(normalizedPath))
      throw new LocalDataRegistryError(
        `Duplicate local-data store path: ${store.relativePath}`,
      );
    if (
      normalizedPath === '.' ||
      posix.isAbsolute(store.relativePath) ||
      win32.isAbsolute(store.relativePath) ||
      normalizedPath === '..' ||
      normalizedPath.startsWith('../') ||
      store.relativePath.includes('\\')
    )
      throw new LocalDataRegistryError(
        `Unsafe local-data store path: ${store.relativePath}`,
      );
    if (!Number.isInteger(store.schemaVersion) || store.schemaVersion < 1)
      throw new LocalDataRegistryError(
        `Invalid schema version for ${store.id}`,
      );
    if (
      !Number.isInteger(store.compatibilityVersion) ||
      store.compatibilityVersion < 1
    )
      throw new LocalDataRegistryError(
        `Invalid compatibility version for ${store.id}`,
      );

    const migrations = [...store.migrations].sort((a, b) => a.from - b.from);
    const destinations = new Set<number>();
    for (const migration of migrations) {
      if (migration.to !== migration.from + 1)
        throw new LocalDataRegistryError(
          `Migration ${store.id}/${migration.name} must advance exactly one version`,
        );
      if (destinations.has(migration.to))
        throw new LocalDataRegistryError(
          `Duplicate migration destination ${migration.to} for ${store.id}`,
        );
      destinations.add(migration.to);
    }
    if (store.schemaVersion > 1 && migrations[0]?.from !== 1)
      throw new LocalDataRegistryError(
        `Migrations for ${store.id} must start at schema 1`,
      );
    if (migrations.length > 0) {
      const last = migrations.at(-1);
      if (!last || last.to !== store.schemaVersion)
        throw new LocalDataRegistryError(
          `Migrations for ${store.id} do not terminate at schema ${store.schemaVersion}`,
        );
      for (let index = 1; index < migrations.length; index += 1) {
        if (migrations[index]?.from !== migrations[index - 1]?.to)
          throw new LocalDataRegistryError(
            `Migration gap for ${store.id} before schema ${migrations[index]?.to}`,
          );
      }
    }
    if (store.kind === 'json') {
      const versions = new Set(
        store.versions.map((version) => version.version),
      );
      if (!versions.has(store.schemaVersion))
        throw new LocalDataRegistryError(
          `JSON store ${store.id} has no schema for version ${store.schemaVersion}`,
        );
      for (const migration of migrations) {
        if (!versions.has(migration.from) || !versions.has(migration.to))
          throw new LocalDataRegistryError(
            `JSON store ${store.id} lacks a schema used by ${migration.name}`,
          );
      }
    }
    if (
      store.legacySchemaVersion !== undefined &&
      (!Number.isInteger(store.legacySchemaVersion) ||
        store.legacySchemaVersion < 1 ||
        store.legacySchemaVersion > store.schemaVersion)
    )
      throw new LocalDataRegistryError(
        `Invalid legacy schema version for ${store.id}`,
      );
    ids.add(store.id);
    paths.add(normalizedPath);
  }
}

class LocalDataModule implements LocalData {
  private started = false;
  private startPromise: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      dataDirectory: string;
      klexVersion: string;
      stores: readonly LocalDataStoreDefinition[];
    },
  ) {
    validateLocalDataRegistry(deps.stores);
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    void startPromise.then(
      () => {
        if (this.startPromise === startPromise) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === startPromise) this.startPromise = undefined;
      },
    );
    return startPromise;
  }

  private async startInternal(): Promise<void> {
    if (await recoverInterruptedMigration(this.deps.dataDirectory))
      this.deps.logger.warn('Restored an interrupted local-data migration');

    const inspections = await this.inspect();
    const targets = inspections.filter(
      (inspection) =>
        inspection.needsMigration ||
        inspection.needsInitialization ||
        inspection.needsAdoption,
    );
    if (targets.length === 0) {
      this.started = true;
      return;
    }

    const checkpoint = await createCheckpoint(this.deps.dataDirectory, targets);
    try {
      for (const inspection of targets) await this.prepareStore(inspection);
      const validated = await this.inspect();
      const incomplete = validated.find(
        (inspection) =>
          inspection.needsInitialization ||
          inspection.needsMigration ||
          inspection.needsAdoption,
      );
      if (incomplete)
        throw new Error(
          `Local data store "${incomplete.definition.id}" did not reach its current version`,
        );
      await finishCheckpoint(
        this.deps.dataDirectory,
        checkpoint.id,
        'successful',
      );
      await pruneCheckpoints(this.deps.dataDirectory).catch((error: unknown) =>
        this.deps.logger.warn(
          { error },
          'Could not prune local-data recovery checkpoints',
        ),
      );
      this.deps.logger.info(
        {
          checkpoint: checkpointDirectory(
            this.deps.dataDirectory,
            checkpoint.id,
          ),
          stores: targets.map((target) => target.definition.id),
        },
        'Local data migration completed',
      );
      this.started = true;
    } catch (error) {
      try {
        await restoreCheckpoint(this.deps.dataDirectory, checkpoint.id);
        await finishCheckpoint(
          this.deps.dataDirectory,
          checkpoint.id,
          'failed',
        );
      } catch (restoreError) {
        throw new Error(
          `Local data migration failed and automatic recovery also failed. ` +
            `Checkpoint: ${checkpointDirectory(this.deps.dataDirectory, checkpoint.id)}`,
          { cause: new AggregateError([error, restoreError]) },
        );
      }
      throw new Error(
        `Local data migration failed; original data was restored. ` +
          `Checkpoint: ${checkpointDirectory(this.deps.dataDirectory, checkpoint.id)}`,
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.startPromise;
    } finally {
      this.started = false;
      this.startPromise = undefined;
    }
  }

  async inspect(): Promise<readonly StoreInspection[]> {
    const inspections: StoreInspection[] = [];
    for (const definition of this.deps.stores) {
      const path = join(this.deps.dataDirectory, definition.relativePath);
      const inspection =
        definition.kind === 'json'
          ? await readJsonStoreDocument(
              path,
              definition,
              this.deps.dataDirectory,
            )
          : await inspectSqliteStore(path, definition, this.deps.dataDirectory);
      const metadata = inspection?.metadata;
      const exists = inspection !== undefined;
      const needsInitialization =
        !exists && definition.kind === 'sqlite' && definition.createIfMissing;
      if (!exists && definition.required && !needsInitialization)
        throw new Error(
          `Required local data store "${definition.id}" is missing at "${path}"`,
        );
      inspections.push({
        definition,
        path,
        exists,
        metadata,
        needsInitialization,
        needsAdoption: inspection?.legacy ?? false,
        needsMigration:
          metadata !== undefined &&
          (metadata.schemaVersion < definition.schemaVersion ||
            metadata.compatibilityVersion < definition.compatibilityVersion),
      });
    }
    return inspections;
  }

  private async prepareStore(inspection: StoreInspection): Promise<void> {
    const { definition, path } = inspection;
    if (definition.kind === 'json') {
      const document = await readJsonStoreDocument(
        path,
        definition,
        this.deps.dataDirectory,
      );
      if (!document)
        throw new Error(
          `JSON store "${definition.id}" disappeared during migration`,
        );
      await migrateJsonStore(path, definition, document, this.deps.klexVersion);
      return;
    }
    if (!inspection.metadata) {
      await initializeSqliteStore(path, definition, this.deps.klexVersion);
    } else {
      await migrateSqliteStore(
        path,
        definition,
        inspection.metadata,
        this.deps.klexVersion,
        inspection.needsAdoption,
      );
    }
  }
}

export function createLocalData(deps: LocalDataDependencies): LocalData {
  return new LocalDataModule({
    logger: deps.logging.child({
      name: 'local-data',
      bindings: { module: 'local-data' },
    }),
    dataDirectory: deps.dataDirectory,
    klexVersion: deps.klexVersion,
    stores: deps.stores,
  });
}
