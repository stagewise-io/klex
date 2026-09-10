import { randomUUID } from 'node:crypto';

import type { TextPart, ToolSet } from 'ai';
import z from 'zod';

import { DEFAULT_SESSION_ID } from '@/session/types';

import { SessionInboxUrgency } from '../../inbox';
import type { ExtendedUIMessage } from '../../message-types';
import {
  createDataPart,
  type DataPartTransformers,
  dataPartTransformer,
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  type HistoryProcessingResult,
  isDataPartOf,
  type ProvisionalStepContext,
} from '../extension-api';
import { createTodosStore, type TodosStore } from './storage';
import systemPromptPart from './system-prompt.md';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Todo {
  id: string;
  description: string;
  /** One-shot UTC timestamp at which the agent should revisit this todo. */
  reminderTime: string | null;
}

/**
 * Custom data part that carries a full snapshot of the active todos list.
 * This type is local to the extension — it is NOT registered in the central
 * `CustomUIDataParts` map.
 */
export type TodosDataUIPart = {
  todos: Todo[];
  /** Set only for the todo whose scheduled reminder just fired. */
  reminderTodoId?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TODOS_KEY = 'todos';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 4;
const MAX_ID_ATTEMPTS = 10;

const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TODOS = 100;
const REMINDER_TIMER_SLICE_MS = 24 * 60 * 60 * 1_000;

interface ReminderTimer {
  timer: NodeJS.Timeout;
  reminderTime: string;
}

const todoOutputSchema = z.object({
  id: z.string(),
  description: z.string(),
  reminderTime: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function formatScheduledFor(reminderTime: string): string {
  return new Date(reminderTime).toUTCString();
}

function formatReminderNotice(todoId: string): string {
  return `<todo-reminder>Reminder due for todo ID: ${todoId}</todo-reminder>`;
}

function formatReminderSuffix(todo: Todo): string {
  return todo.reminderTime
    ? ` — reminder: ${formatScheduledFor(todo.reminderTime)}`
    : '';
}

function formatFullList(todos: Todo[]): string {
  if (todos.length === 0) return '<todos>\n</todos>';
  const lines = todos.map((todo, index) => {
    return `${index + 1}. (ID: ${todo.id}) ${todo.description}${formatReminderSuffix(todo)}`;
  });
  return `<todos>\n${lines.join('\n')}\n</todos>`;
}

interface TodosDiff {
  added: Todo[];
  removed: Todo[];
  reminderUpdated: Todo[];
}

function todosEqual(left: readonly Todo[], right: readonly Todo[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (todo, index) =>
        todo.id === right[index]?.id &&
        todo.description === right[index]?.description &&
        todo.reminderTime === right[index]?.reminderTime,
    )
  );
}

function computeDiff(prev: Todo[], current: Todo[]): TodosDiff {
  const prevIds = new Set(prev.map((t) => t.id));
  const currentIds = new Set(current.map((t) => t.id));
  return {
    added: current.filter((t) => !prevIds.has(t.id)),
    removed: prev.filter((t) => !currentIds.has(t.id)),
    reminderUpdated: current.filter((todo) => {
      const previous = prev.find((candidate) => candidate.id === todo.id);
      return (
        previous !== undefined && previous.reminderTime !== todo.reminderTime
      );
    }),
  };
}

function formatDiff(diff: TodosDiff): string {
  const lines: string[] = [];
  for (const todo of diff.added) {
    lines.push(
      `New todo added: (ID: ${todo.id}) ${todo.description}${formatReminderSuffix(todo)}`,
    );
  }
  for (const t of diff.removed) {
    lines.push(`Todo cleared: (ID: ${t.id}) ${t.description}`);
  }
  for (const t of diff.reminderUpdated) {
    lines.push(
      t.reminderTime
        ? `Todo reminder set: (ID: ${t.id}) ${formatScheduledFor(t.reminderTime)}`
        : `Todo reminder cleared: (ID: ${t.id})`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : 'Todos unchanged.';
}

/**
 * Collects all `data-todos` parts from a history, preserving order
 * and associating each part with its containing message ID.
 */
function collectTodoParts(
  history: ExtendedUIMessage[],
): { messageId: string; todos: Todo[] }[] {
  const parts: { messageId: string; todos: Todo[] }[] = [];
  for (const msg of history) {
    for (const part of msg.parts) {
      if (isDataPartOf(TODOS_KEY, part)) {
        const { todos } = (part as { data: TodosDataUIPart }).data;
        parts.push({ messageId: msg.id, todos });
      }
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

class TodosExtension implements Extension {
  private active = false;
  private closed = false;
  private readonly reminderTimers = new Map<string, ReminderTimer>();

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly store: TodosStore,
    private readonly claimStartupTrigger: () => boolean,
  ) {}

  async onStart(): Promise<void> {
    await this.store.start();
    const todos = [...this.store.getTodos()];
    for (const todo of todos) this.armReminder(todo);
    if (this.claimStartupTrigger() && todos.length > 0) {
      this.deps.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [createDataPart(TODOS_KEY, { todos })],
        } as unknown as ExtendedUIMessage,
        SessionInboxUrgency.Default,
      );
    }
    this.deps.logger.info(
      { pendingTodos: todos.length },
      'Todos extension started',
    );
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.clearReminderTimers();
    this.deps.logger.info(
      { pendingTodos: this.store.getTodos().length },
      'Todos extension closed',
    );
  }

  onStepStart(): void {
    this.active = true;
  }

  onStepComplete(): void {
    this.active = false;
  }

  getTools(): ToolSet {
    return {
      createTodo: {
        inputSchema: z.object({
          description: z
            .string()
            .min(1)
            .max(MAX_DESCRIPTION_LENGTH)
            .describe(
              'Task. Include action, requester, conversation IDs, links, priority, and needed context.',
            ),
          after: z
            .string()
            .trim()
            .nullable()
            .optional()
            .describe('Existing todo ID. Insert after it. If empty: append.'),
          reminderTime: z
            .string()
            .trim()
            .nullable()
            .optional()
            .describe('Optional. ISO 8601 time. Past or empty: no reminder.'),
        }),
        outputSchema: z.object({
          id: z.string(),
          todos: z.array(todoOutputSchema),
        }),
        execute: async ({ description, after, reminderTime }) => {
          if (this.closed) {
            throw new Error('Todos extension is closed — cannot create todos');
          }
          return this.createTodo(
            description,
            after?.trim() || undefined,
            this.normalizeReminder(reminderTime),
          );
        },
      },
      changeTodoReminder: {
        inputSchema: z.object({
          id: z.string().min(1).describe('Todo ID.'),
          reminderTime: z
            .string()
            .trim()
            .nullable()
            .optional()
            .describe('ISO 8601 time. Past or empty: clear.'),
        }),
        outputSchema: z.object({
          updated: z.boolean(),
          todos: z.array(todoOutputSchema),
        }),
        execute: async ({ id, reminderTime }) => {
          if (this.closed) {
            throw new Error(
              'Todos extension is closed — cannot update reminders',
            );
          }
          return this.changeTodoReminder(
            id,
            this.normalizeReminder(reminderTime),
          );
        },
      },
      clearTodo: {
        inputSchema: z.object({
          id: z.string().min(1).describe('Todo ID.'),
        }),
        outputSchema: z.object({
          cancelled: z.boolean(),
          todos: z.array(todoOutputSchema),
        }),
        execute: async ({ id }) => {
          if (this.closed) {
            throw new Error('Todos extension is closed — cannot clear todos');
          }
          return this.clearTodo(id);
        },
      },
    } satisfies ToolSet;
  }

  getSystemPromptPart(): string {
    return systemPromptPart;
  }

  async getProvisionalStepContext(
    history: readonly ExtendedUIMessage[],
  ): Promise<ProvisionalStepContext> {
    await this.store.start();
    const todos = [...this.store.getTodos()];
    const existingParts = collectTodoParts([...history]);
    const previous = existingParts.at(-1)?.todos;
    if (previous && todosEqual(previous, todos)) return { parts: [] };
    if (!previous && todos.length === 0) return { parts: [] };
    const parts = [
      createDataPart(TODOS_KEY, { todos }),
    ] as unknown as ExtendedUIMessage['parts'];
    return { parts };
  }

  historyTransformer(history: ExtendedUIMessage[]): HistoryProcessingResult {
    // Get the full un-sliced history to detect whether compaction
    // removed any data-todos parts.
    const fullHistory = this.deps.getHistory();

    const fullParts = collectTodoParts(fullHistory);
    const compactedParts = collectTodoParts(history);

    if (fullParts.length === 0) return history;

    // Detect compaction: parts in the full history whose containing
    // message is NOT present in the compacted history were sliced away.
    const compactedMessageIds = new Set(compactedParts.map((p) => p.messageId));
    const removedParts = fullParts.filter(
      (p) => !compactedMessageIds.has(p.messageId),
    );

    // The last removed part's todos array is the state that existed
    // just before the compaction boundary. We inject it as a full-list
    // message at position 0 so the model always has at least one
    // complete todo list in context.
    const baseState =
      removedParts.length > 0
        ? (removedParts[removedParts.length - 1]?.todos ?? null)
        : null;

    const output: ExtendedUIMessage[] = [];

    // diffBase tracks the previous todo state for diff computation.
    // If we injected a base state, diffs are computed against it.
    // If not, the first data-todos part renders as a full list.
    let diffBase: Todo[] | null = baseState;

    if (baseState !== null) {
      output.push({
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: formatFullList(baseState) }],
      } as unknown as ExtendedUIMessage);
    }

    // Walk the compacted history, replacing each data-todos part
    // with a text part.
    for (const msg of history) {
      let hasTodoPart = false;
      const newParts = msg.parts.map((part) => {
        if (isDataPartOf(TODOS_KEY, part)) {
          hasTodoPart = true;
          const { todos, reminderTodoId } = (part as { data: TodosDataUIPart })
            .data;
          let text: string;
          if (diffBase === null) {
            // First occurrence with no injection → render full list.
            text = formatFullList(todos);
          } else {
            const diff = computeDiff(diffBase, todos);
            text = formatDiff(diff);
          }
          diffBase = todos;
          if (reminderTodoId) {
            text += `\n${formatReminderNotice(reminderTodoId)}`;
          }
          return { type: 'text', text } as TextPart;
        }
        return part;
      });

      output.push(
        hasTodoPart ? ({ ...msg, parts: newParts } as ExtendedUIMessage) : msg,
      );
    }

    return output;
  }

  dataPartTransformers: DataPartTransformers = {
    [TODOS_KEY]: dataPartTransformer<TodosDataUIPart>((data) => [
      {
        type: 'text',
        text:
          formatFullList(data.todos) +
          (data.reminderTodoId
            ? `\n${formatReminderNotice(data.reminderTodoId)}`
            : ''),
      },
    ]),
  };

  introspect(): Record<string, unknown> {
    const todos = this.store.getTodos().map((todo) => ({
      id: todo.id,
      description: todo.description,
      reminderTime: todo.reminderTime,
      ...(todo.reminderTime
        ? { reminderTimeReadable: formatScheduledFor(todo.reminderTime) }
        : {}),
    }));

    return {
      todoCount: todos.length,
      todos,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal todo management
  // ---------------------------------------------------------------------------

  private async createTodo(
    description: string,
    after: string | undefined,
    reminderTime: string | null,
  ): Promise<{ id: string; todos: Todo[] }> {
    let id = '';
    const todos = await this.store.update((current) => {
      if (current.length >= MAX_TODOS) {
        throw new Error(
          `Maximum of ${MAX_TODOS} concurrent todos reached — clear one before creating a new one`,
        );
      }
      id = generateTodoId(new Set(current.map((todo) => todo.id)));
      const todo: Todo = { id, description, reminderTime };
      if (after === undefined) {
        current.push(todo);
        return;
      }
      const index = current.findIndex((candidate) => candidate.id === after);
      if (index === -1) {
        throw new Error(
          `Todo with id "${after}" not found — cannot insert after it`,
        );
      }
      current.splice(index + 1, 0, todo);
    });
    const createdTodo = todos.find((todo) => todo.id === id);
    if (createdTodo) this.armReminder(createdTodo);
    this.deps.logger.debug(
      { id, description, after, reminderTime },
      'Todo created',
    );
    return { id, todos: [...todos] };
  }

  private async clearTodo(id: string): Promise<{
    cancelled: boolean;
    todos: Todo[];
  }> {
    let cancelled = false;
    const todos = await this.store.update((current) => {
      const index = current.findIndex((todo) => todo.id === id);
      if (index === -1) return;
      current.splice(index, 1);
      cancelled = true;
    });
    if (cancelled) {
      this.clearReminder(id);
      this.deps.logger.debug({ id }, 'Todo cleared');
    }
    return { cancelled, todos: [...todos] };
  }

  private normalizeReminder(
    reminderTime: string | null | undefined,
  ): string | null {
    const normalized = reminderTime?.trim();
    if (!normalized) return null;

    const target = Date.parse(normalized);
    if (!Number.isFinite(target)) {
      throw new Error('Invalid ISO 8601 datetime string');
    }
    const delay = target - Date.now();
    if (delay <= 0) return null;
    return normalized;
  }

  private async changeTodoReminder(
    id: string,
    reminderTime: string | null,
  ): Promise<{ updated: boolean; todos: Todo[] }> {
    let updated = false;
    const todos = await this.store.update((current) => {
      const todo = current.find((candidate) => candidate.id === id);
      if (!todo) return;
      todo.reminderTime = reminderTime;
      updated = true;
    });
    if (!updated) return { updated: false, todos: [...todos] };

    this.clearReminder(id);
    const updatedTodo = todos.find((todo) => todo.id === id);
    if (updatedTodo) this.armReminder(updatedTodo);
    this.deps.logger.debug({ id, reminderTime }, 'Todo reminder updated');
    return { updated: true, todos: [...todos] };
  }

  private armReminder(todo: Todo): void {
    const reminderTime = todo.reminderTime;
    if (!reminderTime) return;
    const target = Date.parse(reminderTime);
    const delay = target - Date.now();
    if (delay <= 0) {
      this.runReminder(todo.id, reminderTime);
      return;
    }
    this.clearReminder(todo.id);
    const timer = setTimeout(
      () => {
        if (Date.parse(reminderTime) > Date.now()) {
          this.armReminder(todo);
          return;
        }
        this.runReminder(todo.id, reminderTime);
      },
      Math.min(delay, REMINDER_TIMER_SLICE_MS),
    );
    this.reminderTimers.set(todo.id, { timer, reminderTime });
  }

  private runReminder(id: string, reminderTime: string): void {
    void this.fireReminder(id, reminderTime).catch((error) => {
      this.deps.logger.error(
        { error, todoId: id, reminderTime },
        'Todo reminder failed',
      );
    });
  }

  private async fireReminder(id: string, reminderTime: string): Promise<void> {
    this.clearReminder(id, reminderTime);
    let due = false;
    const todos = await this.store.update((current) => {
      const todo = current.find((candidate) => candidate.id === id);
      if (todo?.reminderTime !== reminderTime) return;
      todo.reminderTime = null;
      due = true;
    });
    if (this.active || this.closed || !due) return;
    this.deps.inbox.sendMessage(
      {
        id: randomUUID(),
        role: 'user',
        parts: [createDataPart(TODOS_KEY, { todos, reminderTodoId: id })],
      } as unknown as ExtendedUIMessage,
      SessionInboxUrgency.Default,
    );
  }

  private clearReminder(id: string, expectedReminderTime?: string): void {
    const entry = this.reminderTimers.get(id);
    if (
      !entry ||
      (expectedReminderTime && entry.reminderTime !== expectedReminderTime)
    )
      return;
    clearTimeout(entry.timer);
    this.reminderTimers.delete(id);
  }

  private clearReminderTimers(): void {
    for (const entry of this.reminderTimers.values()) clearTimeout(entry.timer);
    this.reminderTimers.clear();
  }
}

class TodosExtensionFactory implements ExtensionFactory {
  readonly identifier = 'io.stagewise/todos';
  readonly displayName = 'Todos';
  private readonly stores = new Map<string, TodosStore>();
  private readonly claimedStartupTriggers = new Set<string>();

  create = (deps: ExtensionDeps): Extension => {
    const dataDirectory = deps.getDataDir(true);
    let store = this.stores.get(dataDirectory);
    if (!store) {
      store = createTodosStore(dataDirectory);
      this.stores.set(dataDirectory, store);
    }
    const claimStartupTrigger = (): boolean => {
      if (
        deps.sessionId !== DEFAULT_SESSION_ID ||
        this.claimedStartupTriggers.has(dataDirectory)
      ) {
        return false;
      }
      this.claimedStartupTriggers.add(dataDirectory);
      return true;
    };
    return new TodosExtension(deps, store, claimStartupTrigger);
  };
}

export const createTodosExt: ExtensionFactory = new TodosExtensionFactory();
