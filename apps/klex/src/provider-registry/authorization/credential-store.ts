import { dirname } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  type LocalDataMetadata,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

const storedCredentialSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    idToken: z.string().min(1).optional(),
    expiresAt: z.string().optional(),
    accountId: z.string().min(1).optional(),
    obtainedAt: z.string(),
    refreshedAt: z.string().optional(),
  })
  .passthrough();

const storedFailureSchema = z
  .object({ code: z.string(), message: z.string(), at: z.string() })
  .passthrough();

const storedProviderSchema = z
  .object({
    type: z.string().min(1),
    status: z.enum(['authorized', 'revoked']),
    credential: storedCredentialSchema.optional(),
    failure: storedFailureSchema.optional(),
  })
  .passthrough();

const providerCredentialStoreSchema = z
  .object({
    providers: z.record(z.string(), storedProviderSchema).default({}),
  })
  .passthrough();

export type StoredProviderCredential = z.infer<typeof storedCredentialSchema>;
export type StoredProviderFailure = z.infer<typeof storedFailureSchema>;
export type StoredProviderAuthorization = z.infer<typeof storedProviderSchema>;
type ProviderCredentialStoreData = z.infer<
  typeof providerCredentialStoreSchema
>;

export const PROVIDER_CREDENTIALS_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'provider-credentials',
  relativePath: 'credentials/providers.json',
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.28.3',
  legacySchemaVersion: 1,
  versions: [{ version: 1, schema: providerCredentialStoreSchema }],
  migrations: [],
};

/**
 * Registry-owned credentials for providers with interactive authorization.
 * Tokens rotate, so they never live in `config.json` (every config write
 * clears provider caches). Writes are serialized; the file is owner-only.
 */
export class ProviderCredentialStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  private metadata: LocalDataMetadata | undefined;
  private readonly dataDirectory: string;

  public constructor(private readonly filePath: string) {
    this.dataDirectory = dirname(dirname(filePath));
  }

  public async load(): Promise<Record<string, StoredProviderAuthorization>> {
    await this.mutationQueue;
    return (await this.read()).providers;
  }

  public async get(
    instanceId: string,
  ): Promise<StoredProviderAuthorization | undefined> {
    return (await this.load())[instanceId];
  }

  public async save(
    instanceId: string,
    type: string,
    credential: StoredProviderCredential,
  ): Promise<void> {
    await this.mutate((data) => {
      data.providers[instanceId] = { type, status: 'authorized', credential };
      return true;
    });
  }

  public async markRevoked(
    instanceId: string,
    type: string,
    failure: StoredProviderFailure,
  ): Promise<void> {
    await this.mutate((data) => {
      data.providers[instanceId] = { type, status: 'revoked', failure };
      return true;
    });
  }

  public async delete(instanceId: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((data) => {
      if (!(instanceId in data.providers)) return false;
      delete data.providers[instanceId];
      deleted = true;
      return true;
    });
    return deleted;
  }

  // `update` returns whether anything changed; unchanged data is not rewritten.
  private async mutate(
    update: (data: ProviderCredentialStoreData) => boolean,
  ): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const data = await this.read();
      if (update(data)) await this.write(data);
    });
    this.mutationQueue = mutation.catch(() => undefined);
    await mutation;
  }

  private async read(): Promise<ProviderCredentialStoreData> {
    const document = await readCurrentJsonStore<ProviderCredentialStoreData>(
      this.filePath,
      PROVIDER_CREDENTIALS_STORE_DEFINITION,
      this.dataDirectory,
    );
    if (!document) return { providers: {} };
    this.metadata = document.metadata;
    return document.payload;
  }

  private async write(data: ProviderCredentialStoreData): Promise<void> {
    this.metadata = await writeJsonStoreDocument(
      this.filePath,
      PROVIDER_CREDENTIALS_STORE_DEFINITION,
      data,
      KLEX_VERSION,
      this.metadata,
    );
  }
}
