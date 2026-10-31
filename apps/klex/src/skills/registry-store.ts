import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  type LocalDataMetadata,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

export const SKILLS_DIRECTORY = 'skills';
const REGISTRY_FILE = 'registry.json';

const isoTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'Timestamp must be a valid ISO 8601 datetime',
  });
const position = z.number().int().nonnegative();

const skillUsageSchema = z
  .object({
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    lastReadAt: isoTimestamp.nullable(),
    readCount: position,
    createdTurn: position,
    updatedTurn: position,
    lastReadTurn: position.nullable(),
    userEdited: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const skillRegistryPayloadSchema = z
  .object({
    turn: position,
    skills: z.record(z.string(), skillUsageSchema),
  })
  .passthrough();

export const SKILL_REGISTRY_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'skill-registry',
  relativePath: `${SKILLS_DIRECTORY}/${REGISTRY_FILE}`,
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.28.0',
  versions: [{ version: 1, schema: skillRegistryPayloadSchema }],
  migrations: [],
};

/** Persisted bookkeeping of one skill, keyed by qualified id. */
export interface StoredSkillUsage {
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  readCount: number;
  createdTurn: number;
  updatedTurn: number;
  lastReadTurn: number | null;
  userEdited: boolean;
  metadata: Record<string, unknown>;
  [unknown: string]: unknown;
}

export interface RegistryDocument {
  turn: number;
  skills: Record<string, StoredSkillUsage>;
  [unknown: string]: unknown;
}

export interface RegistryFile {
  load(): Promise<RegistryDocument | null>;
  save(document: RegistryDocument): Promise<void>;
}

/** `skills/registry.json`, preserving unknown fields and store metadata. */
export function createRegistryFile(dataDirectory: string): RegistryFile {
  const path = join(dataDirectory, SKILLS_DIRECTORY, REGISTRY_FILE);
  let metadata: LocalDataMetadata | undefined;
  return {
    async load() {
      const document = await readCurrentJsonStore<RegistryDocument>(
        path,
        SKILL_REGISTRY_STORE_DEFINITION,
        dataDirectory,
      );
      if (!document) return null;
      metadata = document.metadata;
      return document.payload;
    },
    async save(document) {
      metadata = await writeJsonStoreDocument(
        path,
        SKILL_REGISTRY_STORE_DEFINITION,
        document,
        KLEX_VERSION,
        metadata,
      );
    },
  };
}
