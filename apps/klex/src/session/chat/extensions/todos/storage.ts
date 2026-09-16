import { join } from 'node:path';

import { z } from 'zod';

import {
  type JsonStoreDefinition,
  type LocalDataMetadata,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

import type { Todo } from './todos';

const todoSchema = z
  .object({
    id: z.string().length(4),
    description: z.string().min(1).max(500),
    reminderTime: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), {
        message: 'Reminder timestamp must be a valid ISO 8601 datetime',
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const todosPayloadSchema = z
  .object({
    todos: z.array(todoSchema).max(100),
  })
  .passthrough();

export const TODOS_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'todos-extension-todos',
  relativePath: 'extensions/io.stagewise/todos/todos.json',
  required: false,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.4.0',
  versions: [{ version: 1, schema: todosPayloadSchema }],
  migrations: [],
};

export interface TodosStore {
  start(): Promise<void>;
  getTodos(): readonly Todo[];
  update(mutate: (todos: Todo[]) => void): Promise<readonly Todo[]>;
}

class TodosStoreModule implements TodosStore {
  private todos: Todo[] = [];
  private metadata: LocalDataMetadata | undefined;
  private unknownFields: Record<string, unknown> = {};
  private startPromise: Promise<void> | undefined;
  private updateWork = Promise.resolve();

  constructor(private readonly dataDirectory: string) {}

  start(): Promise<void> {
    this.startPromise ??= this.load();
    return this.startPromise;
  }

  getTodos(): readonly Todo[] {
    return this.todos.map((todo) => ({ ...todo }));
  }

  async update(mutate: (todos: Todo[]) => void): Promise<readonly Todo[]> {
    await this.start();
    let result: readonly Todo[] = [];
    const operation = this.updateWork.then(async () => {
      const next = this.todos.map((todo) => ({ ...todo }));
      mutate(next);
      const path = join(this.dataDirectory, 'todos.json');
      this.metadata = await writeJsonStoreDocument(
        path,
        TODOS_STORE_DEFINITION,
        { ...this.unknownFields, todos: next },
        KLEX_VERSION,
        this.metadata,
      );
      this.todos = next;
      result = this.getTodos();
    });
    this.updateWork = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async load(): Promise<void> {
    const document = await readCurrentJsonStore<{ todos: Todo[] }>(
      join(this.dataDirectory, 'todos.json'),
      TODOS_STORE_DEFINITION,
      this.dataDirectory,
    );
    if (!document) return;
    const { todos, ...unknownFields } = document.payload as {
      todos: Todo[];
      [key: string]: unknown;
    };
    this.todos = todos.map((todo) => ({
      ...todo,
      reminderTime: todo.reminderTime ?? null,
    }));
    this.unknownFields = unknownFields;
    this.metadata = document.metadata;
  }
}

export function createTodosStore(dataDirectory: string): TodosStore {
  return new TodosStoreModule(dataDirectory);
}
