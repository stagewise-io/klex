import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  type LocalDataMetadata,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

const FILE_NAME = 'consolidator-state.json';

const writtenSchema = z
  .object({
    kind: z.enum(['entity', 'skill']),
    id: z.string().min(1),
    writtenAt: z.iso.datetime(),
  })
  .passthrough();
const stateSchema = z
  .object({
    /** Changes at or before this instant were reviewed. Null: never ran. */
    lastRunAt: z.iso.datetime().nullable(),
    /** Own writes of a budget-capped run; skipped unless changed after `writtenAt`. */
    written: z.array(writtenSchema),
  })
  .passthrough();

export const MEMORY_CONSOLIDATOR_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'memory-consolidator-state',
  relativePath: `extensions/io.stagewise/memory/${FILE_NAME}`,
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.38.3',
  versions: [{ version: 1, schema: stateSchema }],
  migrations: [],
};
export type ConsolidatorStateData = z.infer<typeof stateSchema>;
export type ConsolidatorWrite = z.infer<typeof writtenSchema>;
export interface ConsolidatorState {
  start(): Promise<void>;
  get(): ConsolidatorStateData;
  update(mutate: (state: ConsolidatorStateData) => void): Promise<void>;
}
class ConsolidatorStateModule implements ConsolidatorState {
  private data: ConsolidatorStateData = { lastRunAt: null, written: [] };
  private metadata: LocalDataMetadata | undefined;
  private starting: Promise<void> | undefined;
  private work = Promise.resolve();
  constructor(private readonly directory: string) {}
  start(): Promise<void> {
    this.starting ??= this.load();
    return this.starting;
  }
  get(): ConsolidatorStateData {
    return structuredClone(this.data);
  }
  async update(mutate: (state: ConsolidatorStateData) => void): Promise<void> {
    const previous = this.work;
    const operation = this.start().then(() =>
      previous.then(async () => {
        const next = this.get();
        mutate(next);
        this.metadata = await writeJsonStoreDocument(
          join(this.directory, FILE_NAME),
          MEMORY_CONSOLIDATOR_STORE_DEFINITION,
          next,
          KLEX_VERSION,
          this.metadata,
        );
        this.data = next;
      }),
    );
    this.work = operation.catch(() => undefined);
    await operation;
  }
  private async load(): Promise<void> {
    const document = await readCurrentJsonStore<ConsolidatorStateData>(
      join(this.directory, FILE_NAME),
      MEMORY_CONSOLIDATOR_STORE_DEFINITION,
      this.directory,
    );
    if (document) {
      this.data = document.payload;
      this.metadata = document.metadata;
    }
  }
}
export function createConsolidatorState(directory: string): ConsolidatorState {
  return new ConsolidatorStateModule(directory);
}
