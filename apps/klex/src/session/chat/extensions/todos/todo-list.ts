import { createTodosStore, type TodosStore } from './storage';
import type { Todo } from './todos';

export const MAX_TODO_DESCRIPTION_LENGTH = 500;
export const MAX_TODOS = 100;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 4;
const MAX_ID_ATTEMPTS = 10;

export type TodoListErrorCode =
  | 'todo_limit_reached'
  | 'todo_not_found'
  | 'invalid_todo';

/** A rejected todo write. `code` is stable; the message is model-facing. */
export class TodoListError extends Error {
  constructor(
    readonly code: TodoListErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TodoListError';
  }
}

export interface CreateTodoInput {
  description: string;
  /** Already normalized: a future ISO 8601 timestamp or `null`. */
  reminderTime: string | null;
  /** Existing todo ID to insert after. Appends when omitted. */
  after?: string;
}

export interface TodoPatch {
  description?: string;
  /** Already normalized: a future ISO 8601 timestamp or `null` to clear. */
  reminderTime?: string | null;
}

/**
 * The agent-wide todo list shared by every todos extension instance and the
 * admin API. Writes are serialized and persisted before they resolve.
 */
export interface TodoList {
  /** True while at least one todos extension is running. */
  isAvailable(): boolean;
  list(): Promise<Todo[]>;
  create(input: CreateTodoInput): Promise<{ todo: Todo; todos: Todo[] }>;
  /** Resolves `todo: null` when the ID is unknown. */
  update(
    id: string,
    patch: TodoPatch,
  ): Promise<{ todo: Todo | null; todos: Todo[] }>;
  delete(id: string): Promise<{ deleted: boolean; todos: Todo[] }>;
}

/** Receives the committed list after every write, whoever made it. */
export type TodoListListener = (todos: readonly Todo[]) => void;

export interface TodoListHub extends TodoList {
  /**
   * Binds the store of the todos extension data directory. Every extension
   * instance binds the same directory; a different one is a wiring error.
   */
  bind(dataDirectory: string): void;
  /** Registers a running extension. Returns a detach function. */
  attach(listener: TodoListListener): () => void;
  start(): Promise<void>;
  getTodos(): readonly Todo[];
  /** Applies a write that is not one of the public operations. */
  mutate(mutate: (todos: Todo[]) => void): Promise<readonly Todo[]>;
}

function generateTodoId(existing: Set<string>): string {
  for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
    let id = '';
    for (let j = 0; j < ID_LENGTH; j++) {
      id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    if (!existing.has(id)) return id;
  }
  throw new Error(
    `Failed to generate a unique todo id after ${MAX_ID_ATTEMPTS} attempts`,
  );
}

function assertDescription(description: string): void {
  if (
    description.length === 0 ||
    description.length > MAX_TODO_DESCRIPTION_LENGTH
  ) {
    throw new TodoListError(
      'invalid_todo',
      `Todo description must be 1 to ${MAX_TODO_DESCRIPTION_LENGTH} characters`,
    );
  }
}

class TodoListModule implements TodoListHub {
  private store: TodosStore | null = null;
  private dataDirectory: string | null = null;
  private readonly listeners = new Set<TodoListListener>();

  bind(dataDirectory: string): void {
    if (this.dataDirectory === dataDirectory) return;
    if (this.dataDirectory !== null) {
      throw new Error(
        `Todo list is already bound to ${this.dataDirectory}, not ${dataDirectory}`,
      );
    }
    this.dataDirectory = dataDirectory;
    this.store = createTodosStore(dataDirectory);
  }

  attach(listener: TodoListListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isAvailable(): boolean {
    return this.listeners.size > 0;
  }

  start(): Promise<void> {
    return this.requireStore().start();
  }

  getTodos(): readonly Todo[] {
    return this.store?.getTodos() ?? [];
  }

  async list(): Promise<Todo[]> {
    await this.start();
    return [...this.getTodos()];
  }

  async mutate(mutate: (todos: Todo[]) => void): Promise<readonly Todo[]> {
    const todos = await this.requireStore().update(mutate);
    for (const listener of [...this.listeners]) listener(todos);
    return todos;
  }

  async create(input: CreateTodoInput): Promise<{ todo: Todo; todos: Todo[] }> {
    assertDescription(input.description);
    let id = '';
    const todos = await this.mutate((current) => {
      if (current.length >= MAX_TODOS) {
        throw new TodoListError(
          'todo_limit_reached',
          `Maximum of ${MAX_TODOS} concurrent todos reached — clear one before creating a new one`,
        );
      }
      id = generateTodoId(new Set(current.map((todo) => todo.id)));
      const todo: Todo = {
        id,
        description: input.description,
        reminderTime: input.reminderTime,
      };
      if (input.after === undefined) {
        current.push(todo);
        return;
      }
      const index = current.findIndex(
        (candidate) => candidate.id === input.after,
      );
      if (index === -1) {
        throw new TodoListError(
          'todo_not_found',
          `Todo with id "${input.after}" not found — cannot insert after it`,
        );
      }
      current.splice(index + 1, 0, todo);
    });
    const todo = todos.find((candidate) => candidate.id === id);
    if (!todo) throw new Error(`Created todo ${id} is missing`);
    return { todo, todos: [...todos] };
  }

  async update(
    id: string,
    patch: TodoPatch,
  ): Promise<{ todo: Todo | null; todos: Todo[] }> {
    if (patch.description !== undefined) assertDescription(patch.description);
    let found = false;
    const todos = await this.mutate((current) => {
      const todo = current.find((candidate) => candidate.id === id);
      if (!todo) return;
      found = true;
      if (patch.description !== undefined) todo.description = patch.description;
      if (patch.reminderTime !== undefined)
        todo.reminderTime = patch.reminderTime;
    });
    return {
      todo: found ? (todos.find((todo) => todo.id === id) ?? null) : null,
      todos: [...todos],
    };
  }

  async delete(id: string): Promise<{ deleted: boolean; todos: Todo[] }> {
    let deleted = false;
    const todos = await this.mutate((current) => {
      const index = current.findIndex((todo) => todo.id === id);
      if (index === -1) return;
      current.splice(index, 1);
      deleted = true;
    });
    return { deleted, todos: [...todos] };
  }

  private requireStore(): TodosStore {
    if (!this.store) throw new Error('Todo list is not bound to a store');
    return this.store;
  }
}

/**
 * Creates the agent-wide todo list. Pass the same instance to every
 * `createTodosExt` and to the admin API.
 */
export function createTodoList(): TodoListHub {
  return new TodoListModule();
}
