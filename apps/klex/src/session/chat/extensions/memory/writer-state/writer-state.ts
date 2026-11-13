import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  type LocalDataMetadata,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

const stateSchema = z
  .object({
    initialized: z.boolean(),
    cursor: z.string().nullable(),
    pendingThrough: z.string().nullable(),
  })
  .passthrough();

export const MEMORY_WRITER_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'memory-writer-state',
  relativePath: 'extensions/io.stagewise/memory-writer/writer-state.json',
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.33.0',
  versions: [{ version: 1, schema: stateSchema }],
  migrations: [],
};
export type WriterStateData = z.infer<typeof stateSchema>;
export interface WriterState {
  start(): Promise<void>;
  get(): WriterStateData;
  update(mutate: (state: WriterStateData) => void): Promise<void>;
}
class WriterStateModule implements WriterState {
  private data: WriterStateData = {
    initialized: false,
    cursor: null,
    pendingThrough: null,
  };
  private metadata: LocalDataMetadata | undefined;
  private starting: Promise<void> | undefined;
  private work = Promise.resolve();
  constructor(private readonly directory: string) {}
  start(): Promise<void> {
    this.starting ??= this.load();
    return this.starting;
  }
  get(): WriterStateData {
    return structuredClone(this.data);
  }
  async update(mutate: (state: WriterStateData) => void): Promise<void> {
    const previous = this.work;
    const operation = this.start().then(() =>
      previous.then(async () => {
        const next = this.get();
        mutate(next);
        this.metadata = await writeJsonStoreDocument(
          join(this.directory, 'writer-state.json'),
          MEMORY_WRITER_STORE_DEFINITION,
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
    const document = await readCurrentJsonStore<WriterStateData>(
      join(this.directory, 'writer-state.json'),
      MEMORY_WRITER_STORE_DEFINITION,
      this.directory,
    );
    if (document) {
      this.data = document.payload;
      this.metadata = document.metadata;
    }
  }
}
export function createWriterState(directory: string): WriterState {
  return new WriterStateModule(directory);
}
