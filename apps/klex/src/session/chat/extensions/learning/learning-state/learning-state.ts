import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  type LocalDataMetadata,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

const STATE_FILE = 'state.json';

const isoTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'Timestamp must be a valid ISO 8601 datetime',
  });

const skillStateSchema = z
  .object({
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    lastReadAt: isoTimestamp.nullable(),
    readCount: z.number().int().nonnegative(),
    sourceEpisodes: z.array(z.string()),
  })
  .passthrough();

const learningStatePayloadSchema = z
  .object({
    cursor: z.string().nullable(),
    episodeFailures: z.record(z.string(), z.number().int().nonnegative()),
    changedRunsSinceConsolidation: z.number().int().nonnegative(),
    lastConsolidationAt: isoTimestamp.nullable(),
    skills: z.record(z.string(), skillStateSchema),
  })
  .passthrough();

const activity = z.number().int().nonnegative();
const deferredSchema = z
  .object({ id: z.string(), after: z.string(), attempts: activity })
  .passthrough();
const activitySkillSchema = skillStateSchema.extend({
  createdEpisode: activity,
  updatedEpisode: activity,
  lastReadEpisode: activity.nullable(),
});
const activityStateSchema = learningStatePayloadSchema.extend({
  processedEpisodeCount: activity,
  pendingChangeWeight: activity,
  lastConsolidationEpisode: activity,
  lastConsolidationSkillCount: activity,
  consolidationFailures: activity,
  nextConsolidationEpisode: activity.nullable(),
  deferred: z.array(deferredSchema).max(20),
  skills: z.record(z.string(), activitySkillSchema),
});

function activityDefaults() {
  return {
    processedEpisodeCount: 0,
    pendingChangeWeight: 0,
    lastConsolidationEpisode: 0,
    lastConsolidationSkillCount: 0,
    consolidationFailures: 0,
    nextConsolidationEpisode: null,
    deferred: [],
  };
}

export const LEARNING_STATE_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'learning-extension-state',
  relativePath: 'extensions/io.stagewise/learning/state.json',
  required: false,
  schemaVersion: 2,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.14.0',
  versions: [
    { version: 1, schema: learningStatePayloadSchema },
    { version: 2, schema: activityStateSchema },
  ],
  migrations: [
    {
      from: 1,
      to: 2,
      name: 'episode-activity',
      up: (value) => {
        const old = learningStatePayloadSchema.parse(value);
        return {
          ...old,
          ...activityDefaults(),
          skills: Object.fromEntries(
            Object.entries(old.skills).map(([name, skill]) => [
              name,
              {
                ...skill,
                createdEpisode: 0,
                updatedEpisode: 0,
                lastReadEpisode: null,
              },
            ]),
          ),
        };
      },
    },
  ],
};

export interface SkillState {
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  readCount: number;
  sourceEpisodes: string[];
  createdEpisode?: number;
  updatedEpisode?: number;
  lastReadEpisode?: number | null;
  [key: string]: unknown;
}

export interface LearningStateData {
  /** Last processed episode id. */
  cursor: string | null;
  /** Episode id → consecutive failures. */
  episodeFailures: Record<string, number>;
  changedRunsSinceConsolidation: number;
  lastConsolidationAt: string | null;
  skills: Record<string, SkillState>;
  processedEpisodeCount: number;
  pendingChangeWeight: number;
  lastConsolidationEpisode: number;
  lastConsolidationSkillCount: number;
  consolidationFailures: number;
  nextConsolidationEpisode: number | null;
  deferred: {
    id: string;
    after: string;
    attempts: number;
    [key: string]: unknown;
  }[];
}

export interface LearningState {
  start(): Promise<void>;
  /** A deep copy of the current state. */
  get(): LearningStateData;
  update(
    mutate: (state: LearningStateData) => void,
  ): Promise<LearningStateData>;
}

function emptyState(): LearningStateData {
  return {
    ...activityDefaults(),
    cursor: null,
    episodeFailures: {},
    changedRunsSinceConsolidation: 0,
    lastConsolidationAt: null,
    skills: {},
  };
}

/**
 * Bookkeeping of the learning extension. Losing it never breaks skills;
 * only the cursor and usage history are lost.
 */
class LearningStateModule implements LearningState {
  private state: LearningStateData = emptyState();
  private metadata: LocalDataMetadata | undefined;
  private unknownFields: Record<string, unknown> = {};
  private startPromise: Promise<void> | undefined;
  private updateWork = Promise.resolve();

  constructor(private readonly dataDirectory: string) {}

  start(): Promise<void> {
    this.startPromise ??= this.load();
    return this.startPromise;
  }

  get(): LearningStateData {
    return structuredClone(this.state);
  }

  async update(
    mutate: (state: LearningStateData) => void,
  ): Promise<LearningStateData> {
    await this.start();
    let result = this.get();
    const operation = this.updateWork.then(async () => {
      const next = this.get();
      mutate(next);
      for (const entry of Object.values(next.skills)) {
        entry.createdEpisode ??= next.processedEpisodeCount;
        entry.updatedEpisode ??= next.processedEpisodeCount;
        entry.lastReadEpisode ??= null;
      }
      this.metadata = await writeJsonStoreDocument(
        join(this.dataDirectory, STATE_FILE),
        LEARNING_STATE_STORE_DEFINITION,
        { ...this.unknownFields, ...next },
        KLEX_VERSION,
        this.metadata,
      );
      this.state = next;
      result = this.get();
    });
    this.updateWork = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async load(): Promise<void> {
    const document = await readCurrentJsonStore<LearningStateData>(
      join(this.dataDirectory, STATE_FILE),
      LEARNING_STATE_STORE_DEFINITION,
      this.dataDirectory,
    );
    if (!document) return;
    const {
      cursor,
      episodeFailures,
      changedRunsSinceConsolidation,
      lastConsolidationAt,
      skills,
      processedEpisodeCount,
      pendingChangeWeight,
      lastConsolidationEpisode,
      lastConsolidationSkillCount,
      consolidationFailures,
      nextConsolidationEpisode,
      deferred,
      ...unknownFields
    } = document.payload as LearningStateData & Record<string, unknown>;
    this.state = {
      cursor,
      episodeFailures,
      changedRunsSinceConsolidation,
      lastConsolidationAt,
      skills,
      processedEpisodeCount,
      pendingChangeWeight,
      lastConsolidationEpisode,
      lastConsolidationSkillCount,
      consolidationFailures,
      nextConsolidationEpisode,
      deferred,
    };
    this.unknownFields = unknownFields;
    this.metadata = document.metadata;
  }
}

export function createLearningState(dataDirectory: string): LearningState {
  return new LearningStateModule(dataDirectory);
}
