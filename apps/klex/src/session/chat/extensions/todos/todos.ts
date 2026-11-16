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
import systemPromptPart from './system-prompt.md';
import { MAX_TODO_DESCRIPTION_LENGTH, type TodoListHub } from './todo-list';

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
  descriptionUpdated: Todo[];
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
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const currentIds = new Set(current.map((t) => t.id));
  return {
    added: current.filter((t) => !prevById.has(t.id)),
    removed: prev.filter((t) => !currentIds.has(t.id)),
    descriptionUpdated: current.filter((todo) => {
      const previous = prevById.get(todo.id);
      return (
        previous !== undefined && previous.description !== todo.description
      );
    }),
    reminderUpdated: current.filter((todo) => {
      const previous = prevById.get(todo.id);
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
  for (const t of diff.descriptionUpdated) {
    lines.push(`Todo updated: (ID: ${t.id}) ${t.description}`);
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
  history: readonly ExtendedUIMessage[],
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
  private closed = false;
  private readonly reminderTimers = new Map<string, ReminderTimer>();
  /** Detached reminder deliveries; awaited on close so restores persist. */
  private readonly pendingReminders = new Set<Promise<void>>();
  /** Reminder time being delivered per todo, so syncs do not re-fire it. */
  private readonly firingReminders = new Map<string, string>();
  private detachList: (() => void) | null = null;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly todoList: TodoListHub,
    private readonly claimStartupTrigger: () => boolean,
  ) {}

  async onStart(): Promise<void> {
    await this.todoList.start();
    if (this.closed) return;
    this.detachList = this.todoList.attach((todos) =>
      this.syncReminders(todos),
    );
    const todos = [...this.todoList.getTodos()];
    this.syncReminders(todos);
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
    this.detachList?.();
    this.detachList = null;
    this.clearReminderTimers();
    await Promise.allSettled([...this.pendingReminders]);
    this.deps.logger.info(
      { pendingTodos: this.todoList.getTodos().length },
      'Todos extension closed',
    );
  }

  getTools(): ToolSet {
    return {
      createTodo: {
        inputSchema: z.object({
          description: z
            .string()
            .min(1)
            .max(MAX_TODO_DESCRIPTION_LENGTH)
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
    await this.todoList.start();
    const todos = [...this.todoList.getTodos()];
    const existingParts = collectTodoParts(history);
    const previous = existingParts.at(-1)?.todos;
    if (previous && todosEqual(previous, todos)) return { parts: [] };
    if (!previous && todos.length === 0) return { parts: [] };
    const parts = [
      createDataPart(TODOS_KEY, { todos }),
    ] as unknown as ExtendedUIMessage['parts'];
    return { parts };
  }

  /**
   * Carries the last todo list from the dropped prefix as a full
   * `data-todos` part. It lands in the checkpoint message at the window
   * head, so the history transformer renders it as the full-list base
   * for subsequent diffs.
   */
  getCheckpointCarry(
    dropped: readonly ExtendedUIMessage[],
  ): ExtendedUIMessage['parts'] {
    const last = collectTodoParts(dropped).at(-1);
    if (!last) return [];
    return [
      createDataPart(TODOS_KEY, { todos: last.todos }),
    ] as unknown as ExtendedUIMessage['parts'];
  }

  historyTransformer(history: ExtendedUIMessage[]): HistoryProcessingResult {
    if (collectTodoParts(history).length === 0) return history;

    const output: ExtendedUIMessage[] = [];

    // The first data-todos part in the window (usually the checkpoint
    // carry) renders as a full list; later parts render as diffs.
    let diffBase: Todo[] | null = null;

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
    const todos = this.todoList.getTodos().map((todo) => ({
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
    const { todo, todos } = await this.todoList.create({
      description,
      reminderTime,
      ...(after === undefined ? {} : { after }),
    });
    this.syncReminders(todos);
    this.deps.logger.debug(
      { id: todo.id, description, after, reminderTime },
      'Todo created',
    );
    return { id: todo.id, todos };
  }

  private async clearTodo(id: string): Promise<{
    cancelled: boolean;
    todos: Todo[];
  }> {
    const { deleted, todos } = await this.todoList.delete(id);
    this.syncReminders(todos);
    if (deleted) this.deps.logger.debug({ id }, 'Todo cleared');
    return { cancelled: deleted, todos };
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
    const { todo, todos } = await this.todoList.update(id, { reminderTime });
    this.syncReminders(todos);
    if (!todo) return { updated: false, todos };
    this.deps.logger.debug({ id, reminderTime }, 'Todo reminder updated');
    return { updated: true, todos };
  }

  /**
   * Aligns this instance's timers with the committed list. Runs after every
   * write, including writes from other sessions and the admin API.
   */
  private syncReminders(todos: readonly Todo[]): void {
    if (this.closed) return;
    const reminders = new Map(
      todos.map((todo) => [todo.id, todo.reminderTime]),
    );
    for (const [id, entry] of this.reminderTimers) {
      if (reminders.get(id) !== entry.reminderTime) this.clearReminder(id);
    }
    for (const todo of todos) {
      if (
        !todo.reminderTime ||
        this.reminderTimers.get(todo.id)?.reminderTime === todo.reminderTime ||
        this.firingReminders.get(todo.id) === todo.reminderTime
      ) {
        continue;
      }
      this.armReminder(todo);
    }
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
    this.firingReminders.set(id, reminderTime);
    const pending = this.fireReminder(id, reminderTime)
      .catch((error) => {
        this.deps.logger.error(
          { error, todoId: id, reminderTime },
          'Todo reminder failed',
        );
      })
      .finally(() => {
        this.pendingReminders.delete(pending);
        if (this.firingReminders.get(id) === reminderTime)
          this.firingReminders.delete(id);
      });
    this.pendingReminders.add(pending);
  }

  private async fireReminder(id: string, reminderTime: string): Promise<void> {
    this.clearReminder(id, reminderTime);
    if (this.closed) return;
    let due = false;
    const todos = await this.todoList.mutate((current) => {
      const todo = current.find((candidate) => candidate.id === id);
      if (todo?.reminderTime !== reminderTime) return;
      todo.reminderTime = null;
      due = true;
    });
    if (!due) return;
    if (this.closed) {
      // Closed between persisting and delivering (e.g. restart teardown):
      // restore the reminder so the next startup fires it instead of
      // losing it.
      await this.todoList.mutate((current) => {
        const todo = current.find((candidate) => candidate.id === id);
        if (todo && todo.reminderTime === null)
          todo.reminderTime = reminderTime;
      });
      return;
    }
    // Deliver even mid-step: Default urgency appends to history and
    // forces a check-retry turn, so the reminder is never lost.
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

export interface TodosExtOptions {
  /** Agent-wide list shared by every session's todos extension. */
  todoList: TodoListHub;
}

class TodosExtensionFactory implements ExtensionFactory {
  readonly identifier = 'io.stagewise/todos';
  readonly displayName = 'Todos';
  private readonly claimedStartupTriggers = new Set<string>();

  constructor(private readonly options: TodosExtOptions) {}

  create = (deps: ExtensionDeps): Extension => {
    const dataDirectory = deps.getDataDir(true);
    this.options.todoList.bind(dataDirectory);
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
    return new TodosExtension(deps, this.options.todoList, claimStartupTrigger);
  };
}

/** Adds durable todo management and default-session startup task recovery. */
export function createTodosExt(options: TodosExtOptions): ExtensionFactory {
  return new TodosExtensionFactory(options);
}
