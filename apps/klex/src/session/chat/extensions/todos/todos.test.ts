import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { DEFAULT_SESSION_ID } from '@/session/types';

import { SessionInboxUrgency } from '../../inbox';
import type { ExtendedUIMessage } from '../../message-types';
import {
  createDataPart,
  type ExtensionDeps,
  type ExtensionFactory,
} from '../extension-api';
import {
  createTodosExt,
  TODOS_KEY,
  type Todo,
  type TodosDataUIPart,
} from './todos';

vi.mock('./system-prompt.md', () => ({
  default:
    '# Todos\n\nTrack short-term work in <todos> blocks with self-contained descriptions. Keep at most 20 active todos. Use `reminderTime` and `changeTodoReminder`; due work arrives in <todo-reminder>. Prefer an external calendar for recurring events.',
}));

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

function createMockDeps(
  initialHistory: ExtendedUIMessage[] = [],
  dataDirectory = mkdtempSync(join(tmpdir(), 'todos-ext-test-')),
  sessionId = 'test-session-id',
): {
  deps: ExtensionDeps;
  sendMessage: ReturnType<typeof vi.fn>;
  setHistory: (history: ExtendedUIMessage[]) => void;
} {
  temporaryDirectories.push(dataDirectory);
  let currentHistory = initialHistory;
  const sendMessage = vi.fn();
  const deps = {
    getHistory: () => currentHistory,
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage,
      close: vi.fn(),
    },
    config: { get: () => ({}) } as unknown as ExtensionDeps['config'],
    generateText: vi.fn(() =>
      Promise.resolve({
        success: false as const,
        failureReason: 'no-models' as const,
      }),
    ),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ModuleLogger,
    logging: {
      child: () =>
        ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          trace: vi.fn(),
        }) as unknown as ModuleLogger,
    } as unknown as ExtensionDeps['logging'],
    mcp: {} as unknown as ExtensionDeps['mcp'],
    router: {} as unknown as ExtensionDeps['router'],
    sessionId,
    getDataDir: vi.fn(() => dataDirectory),
  } as unknown as ExtensionDeps;

  return {
    deps,
    sendMessage,
    setHistory: (history: ExtendedUIMessage[]) => {
      currentHistory = history;
    },
  };
}

function getTool(ext: ReturnType<ExtensionFactory['create']>, name: string) {
  const tools = ext.getTools?.({} as never);
  if (!tools) throw new Error('Extension has no getTools');
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

async function callTool(
  ext: ReturnType<ExtensionFactory['create']>,
  name: string,
  input: Record<string, unknown>,
) {
  const tool = getTool(ext, name);
  const execute = ('execute' in tool ? tool.execute : undefined) as unknown as (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  if (!execute) throw new Error(`Tool ${name} has no execute`);
  return execute(input);
}

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: overrides.id ?? 'test',
    description: overrides.description ?? 'Test todo',
    reminderTime: overrides.reminderTime ?? null,
  };
}

function createTodosMessage(todos: Todo[], id?: string): ExtendedUIMessage {
  return {
    id: id ?? randomUUID(),
    role: 'user',
    parts: [createDataPart(TODOS_KEY, { todos } as TodosDataUIPart)],
  } as unknown as ExtendedUIMessage;
}

function createTextMessage(
  role: 'user' | 'assistant',
  text: string,
  id?: string,
): ExtendedUIMessage {
  return {
    id: id ?? randomUUID(),
    role,
    parts: [{ type: 'text', text }],
  } as unknown as ExtendedUIMessage;
}

function createSummaryMessage(text: string): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    parts: [createDataPart('context-summary', { summary: text })],
  } as unknown as ExtendedUIMessage;
}

function extractTextParts(msg: ExtendedUIMessage): string {
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function introspect(
  ext: ReturnType<ExtensionFactory['create']>,
): Record<string, unknown> {
  if (!ext.introspect) throw new Error('Extension has no introspection');
  return ext.introspect() as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Todos extension', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Tool exposure
  // -------------------------------------------------------------------------

  it('exposes todo and reminder management tools', () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const tools = ext.getTools?.({} as never);
    if (!tools) throw new Error('Extension has no getTools');
    expect(tools).toHaveProperty('createTodo');
    expect(tools).toHaveProperty('changeTodoReminder');
    expect(tools).toHaveProperty('clearTodo');
  });

  // -------------------------------------------------------------------------
  // createTodo
  // -------------------------------------------------------------------------

  it('createTodo returns a 4-char id and the todo in the list', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const result = await callTool(ext, 'createTodo', {
      description: 'Check deploy status',
    });
    expect(result.id).toBeTypeOf('string');
    expect((result.id as string).length).toBe(4);
    const todos = result.todos as Todo[];
    expect(todos).toHaveLength(1);
    expect(todos[0]!.description).toBe('Check deploy status');
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('createTodo treats after=%s as append', async (_label, after) => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const tool = getTool(ext, 'createTodo');
    const schema = tool.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };

    expect(schema.safeParse({ description: 'First todo', after }).success).toBe(
      true,
    );
    const result = await callTool(ext, 'createTodo', {
      description: 'First todo',
      after,
    });

    expect(result.todos).toEqual([
      expect.objectContaining({ description: 'First todo' }),
    ]);
  });

  it('createTodo stores and schedules an optional reminder', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const result = await callTool(ext, 'createTodo', {
      description: 'Check deployment',
      reminderTime: '2025-03-15T11:00:00Z',
    });

    expect(result.todos).toEqual([
      expect.objectContaining({ reminderTime: '2025-03-15T11:00:00Z' }),
    ]);
    expect(introspect(ext).todos).toEqual([
      expect.objectContaining({
        reminderTime: '2025-03-15T11:00:00Z',
        reminderTimeReadable: 'Sat, 15 Mar 2025 11:00:00 GMT',
      }),
    ]);
  });

  it('createTodo stores a past reminder time as null', async () => {
    const { deps, sendMessage } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const result = await callTool(ext, 'createTodo', {
      description: 'Already elapsed',
      reminderTime: '2025-03-15T09:00:00Z',
    });

    expect(result.todos).toEqual([
      expect.objectContaining({ reminderTime: null }),
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('createTodo appends to end of list by default', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await callTool(ext, 'createTodo', { description: 'First' });
    await callTool(ext, 'createTodo', { description: 'Second' });
    await callTool(ext, 'createTodo', { description: 'Third' });
    const todos = introspect(ext).todos as Todo[];
    expect(todos.map((t) => t.description)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });

  it('createTodo with after inserts after the specified todo', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const r1 = await callTool(ext, 'createTodo', {
      description: 'First',
    });
    await callTool(ext, 'createTodo', { description: 'Second' });
    const r3 = await callTool(ext, 'createTodo', {
      description: 'Inserted after First',
      after: r1.id,
    });
    const todos = introspect(ext).todos as Todo[];
    expect(todos.map((t) => t.description)).toEqual([
      'First',
      'Inserted after First',
      'Second',
    ]);
    // The inserted todo should be at index 1
    expect(todos[1]!.id).toBe(r3.id);
  });

  it('createTodo with after at end of list', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const _r1 = await callTool(ext, 'createTodo', {
      description: 'First',
    });
    const r2 = await callTool(ext, 'createTodo', {
      description: 'Second',
    });
    await callTool(ext, 'createTodo', {
      description: 'After Second',
      after: r2.id,
    });
    const todos = introspect(ext).todos as Todo[];
    expect(todos.map((t) => t.description)).toEqual([
      'First',
      'Second',
      'After Second',
    ]);
  });

  it('createTodo with unknown after id throws', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await callTool(ext, 'createTodo', { description: 'First' });
    await expect(
      callTool(ext, 'createTodo', {
        description: 'Should fail',
        after: 'zzzz',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('createTodo persists without sending inbox input', async () => {
    const { deps, sendMessage } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await callTool(ext, 'createTodo', { description: 'Test' });
    expect(sendMessage).not.toHaveBeenCalled();
    const context = await ext.getProvisionalStepContext?.([], {} as never);
    const part = context?.parts[0];
    expect(part?.type).toBe('data-todos');
    const data = (part as unknown as { data: TodosDataUIPart }).data;
    expect(data.todos).toEqual([
      expect.objectContaining({ description: 'Test' }),
    ]);
  });

  it('createTodo rejects empty description via zod schema', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const tool = getTool(ext, 'createTodo');
    const schema = tool.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const result = schema.safeParse({ description: '' });
    expect(result.success).toBe(false);
  });

  it('createTodo rejects description > 500 chars via zod schema', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const tool = getTool(ext, 'createTodo');
    const schema = tool.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const result = schema.safeParse({ description: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('createTodo rejects after onClose', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await ext.onClose?.();
    await expect(
      callTool(ext, 'createTodo', {
        description: 'Should fail',
      }),
    ).rejects.toThrow(/closed/);
  });

  it('createTodo rejects when MAX_TODOS (100) is reached', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    for (let i = 0; i < 100; i++) {
      await callTool(ext, 'createTodo', {
        description: `Todo ${i}`,
      });
    }
    await expect(
      callTool(ext, 'createTodo', {
        description: 'Should fail',
      }),
    ).rejects.toThrow(/maximum of 100/i);
  });

  it('allows creating a new todo after clearing one at the limit', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const first = await callTool(ext, 'createTodo', {
      description: 'First',
    });
    for (let i = 0; i < 99; i++) {
      await callTool(ext, 'createTodo', {
        description: `Todo ${i}`,
      });
    }
    await callTool(ext, 'clearTodo', { id: first.id });
    const result = await callTool(ext, 'createTodo', {
      description: 'After clear',
    });
    expect(result.id).toBeTypeOf('string');
  });

  it('generates unique 4-char ids with collision detection', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = await callTool(ext, 'createTodo', {
        description: `Todo ${i}`,
      });
      const id = result.id as string;
      expect(id.length).toBe(4);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(20);
  });

  // -------------------------------------------------------------------------
  // changeTodoReminder
  // -------------------------------------------------------------------------

  it('updates, clears, and reports a todo reminder', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const created = await callTool(ext, 'createTodo', {
      description: 'Check deploy',
    });

    const updated = await callTool(ext, 'changeTodoReminder', {
      id: created.id,
      reminderTime: '2025-03-15T11:00:00Z',
    });
    expect(updated).toEqual({
      updated: true,
      todos: [
        expect.objectContaining({ reminderTime: '2025-03-15T11:00:00Z' }),
      ],
    });

    const cleared = await callTool(ext, 'changeTodoReminder', {
      id: created.id,
      reminderTime: null,
    });
    expect(cleared).toEqual({
      updated: true,
      todos: [expect.not.objectContaining({ reminderTime: expect.anything() })],
    });

    const elapsed = await callTool(ext, 'changeTodoReminder', {
      id: created.id,
      reminderTime: '2025-03-15T09:00:00Z',
    });
    expect(elapsed).toEqual({
      updated: true,
      todos: [expect.objectContaining({ reminderTime: null })],
    });

    expect(
      await callTool(ext, 'changeTodoReminder', {
        id: 'zzzz',
        reminderTime: '2025-03-15T11:00:00Z',
      }),
    ).toMatchObject({ updated: false });
  });

  it('supports reminders beyond the native timer delay limit', async () => {
    const { deps, sendMessage } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const created = await callTool(ext, 'createTodo', {
      description: 'Review monthly report',
      reminderTime: '2025-04-15T10:00:00Z',
    });

    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1_000);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(introspect(ext).todos).toEqual([
      expect.objectContaining({
        id: created.id,
        reminderTime: '2025-04-15T10:00:00Z',
      }),
    ]);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(introspect(ext).todos).toEqual([
      expect.not.objectContaining({ reminderTime: expect.anything() }),
    ]);
  });

  it('fires a due todo reminder once and clears its timestamp', async () => {
    const { deps, sendMessage } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const created = await callTool(ext, 'createTodo', {
      description: 'Check deploy',
      reminderTime: '2025-03-15T10:00:01Z',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            type: 'data-todos',
            data: expect.objectContaining({ reminderTodoId: created.id }),
          }),
        ],
      }),
      SessionInboxUrgency.Default,
    );
    expect(introspect(ext).todos).toEqual([
      expect.not.objectContaining({ reminderTime: expect.anything() }),
    ]);
  });

  // -------------------------------------------------------------------------
  // clearTodo
  // -------------------------------------------------------------------------

  it('clearTodo on existing id returns cancelled: true and updated list', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const created = await callTool(ext, 'createTodo', {
      description: 'To be cleared',
    });
    const result = await callTool(ext, 'clearTodo', {
      id: created.id,
    });
    expect(result.cancelled).toBe(true);
    expect(result.todos as Todo[]).toEqual([]);
  });

  it('clearTodo preserves order of remaining todos', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const r1 = await callTool(ext, 'createTodo', {
      description: 'First',
    });
    await callTool(ext, 'createTodo', { description: 'Second' });
    const r3 = await callTool(ext, 'createTodo', {
      description: 'Third',
    });
    await callTool(ext, 'clearTodo', { id: r1.id });
    const todos = introspect(ext).todos as Todo[];
    expect(todos.map((t) => t.description)).toEqual(['Second', 'Third']);
    await callTool(ext, 'clearTodo', { id: r3.id });
    const todos2 = introspect(ext).todos as Todo[];
    expect(todos2.map((t) => t.description)).toEqual(['Second']);
  });

  it('clearTodo on unknown id returns cancelled: false with unchanged list', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await callTool(ext, 'createTodo', {
      description: 'Existing',
    });
    const result = await callTool(ext, 'clearTodo', {
      id: 'zzzz',
    });
    expect(result.cancelled).toBe(false);
    expect(result.todos as Todo[]).toHaveLength(1);
  });

  it('clearTodo never sends inbox input', async () => {
    const { deps, sendMessage } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const created = await callTool(ext, 'createTodo', {
      description: 'To clear',
    });
    await callTool(ext, 'clearTodo', { id: 'zzzz' });
    await callTool(ext, 'clearTodo', { id: created.id });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('clearTodo rejects after onClose', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await ext.onClose?.();
    await expect(callTool(ext, 'clearTodo', { id: 'aaaa' })).rejects.toThrow(
      /closed/,
    );
  });

  // -------------------------------------------------------------------------
  // onStart
  // -------------------------------------------------------------------------

  it('onStart with no todos does not inject a data part', async () => {
    const { deps, sendMessage } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await ext.onStart?.();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('triggers the primary session once on startup when todos are open', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'todos-ext-startup-'));
    const seed = createMockDeps([], dataDirectory);
    const seedExt = createTodosExt.create(seed.deps);
    await callTool(seedExt, 'createTodo', {
      description: 'Resume pending work',
    });

    const primary = createMockDeps([], dataDirectory, DEFAULT_SESSION_ID);
    const primaryExt = createTodosExt.create(primary.deps);
    await primaryExt.onStart?.();

    expect(primary.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        parts: [expect.objectContaining({ type: 'data-todos' })],
      }),
      SessionInboxUrgency.Default,
    );

    const replacement = createMockDeps([], dataDirectory, DEFAULT_SESSION_ID);
    const replacementExt = createTodosExt.create(replacement.deps);
    await replacementExt.onStart?.();
    expect(replacement.sendMessage).not.toHaveBeenCalled();
  });

  it('does not trigger an ad-hoc session when persisted todos are open', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'todos-ext-adhoc-'));
    const seed = createMockDeps([], dataDirectory);
    const seedExt = createTodosExt.create(seed.deps);
    await callTool(seedExt, 'createTodo', {
      description: 'Resume pending work',
    });

    const adHoc = createMockDeps([], dataDirectory, 'ad-hoc-session');
    const adHocExt = createTodosExt.create(adHoc.deps);
    await adHocExt.onStart?.();
    expect(adHoc.sendMessage).not.toHaveBeenCalled();
  });

  it('shares persisted todos across session instances without inbox input', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'todos-ext-shared-'));
    const first = createMockDeps([], dataDirectory);
    const second = createMockDeps([], dataDirectory);
    const firstExt = createTodosExt.create(first.deps);
    const secondExt = createTodosExt.create(second.deps);
    await Promise.all([firstExt.onStart?.(), secondExt.onStart?.()]);
    await callTool(firstExt, 'createTodo', { description: 'Shared' });
    const context = await secondExt.getProvisionalStepContext?.(
      [],
      {} as never,
    );
    if (!context) throw new Error('Expected provisional todo context');
    const data = (context.parts[0] as unknown as { data: TodosDataUIPart })
      .data;
    expect(data.todos).toEqual([
      expect.objectContaining({ description: 'Shared' }),
    ]);
    expect(first.sendMessage).not.toHaveBeenCalled();
    expect(second.sendMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // historyTransformer
  // -------------------------------------------------------------------------

  it('historyTransformer returns history unchanged when no data-todos parts exist', () => {
    const { deps, setHistory } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const history = [
      createTextMessage('user', 'Hello'),
      createTextMessage('assistant', 'Hi there'),
    ];
    setHistory(history);
    const result = ext.historyTransformer?.(
      history,
      {} as never,
    ) as ExtendedUIMessage[];
    expect(result).toBe(history);
  });

  it('historyTransformer renders first data-todos part as full list', () => {
    const { deps, setHistory } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const t1 = makeTodo({ id: 'aaaa', description: 'Task A' });
    const history = [
      createTextMessage('user', 'Set a todo'),
      createTodosMessage([t1]),
      createTextMessage('assistant', 'Done'),
    ];
    setHistory(history);
    const result = ext.historyTransformer?.(
      history,
      {} as never,
    ) as ExtendedUIMessage[];
    expect(result).toHaveLength(3);
    // The second message (index 1) should have its data-todos part replaced with text
    const text = extractTextParts(result[1]!);
    expect(text).toContain('<todos>');
    expect(text).toContain('1. (ID: aaaa) Task A');
    expect(text).toContain('</todos>');
    expect(text).not.toContain('New todo added');
    expect(text).not.toContain('Todo cleared');
  });

  it('historyTransformer renders subsequent parts as diffs', () => {
    const { deps, setHistory } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const t1 = makeTodo({ id: 'aaaa', description: 'Task A' });
    const t2 = makeTodo({ id: 'bbbb', description: 'Task B' });
    const history = [
      createTextMessage('user', 'Start'),
      createTodosMessage([t1]),
      createTextMessage('assistant', 'Set'),
      createTodosMessage([t1, t2]),
      createTextMessage('assistant', 'Added B'),
      createTodosMessage([t2]),
      createTextMessage('assistant', 'Cleared A'),
    ];
    setHistory(history);
    const result = ext.historyTransformer?.(
      history,
      {} as never,
    ) as ExtendedUIMessage[];
    // Part 1 (index 1): full list
    const text1 = extractTextParts(result[1]!);
    expect(text1).toContain('<todos>');
    expect(text1).not.toContain('New todo added');
    // Part 2 (index 3): diff — added bbbb
    const text2 = extractTextParts(result[3]!);
    expect(text2).toContain('New todo added');
    expect(text2).toContain('bbbb');
    expect(text2).not.toContain('<todos>');
    // Part 3 (index 5): diff — cleared aaaa
    const text3 = extractTextParts(result[5]!);
    expect(text3).toContain('Todo cleared');
    expect(text3).toContain('aaaa');
    expect(text3).not.toContain('<todos>');
  });

  it('historyTransformer injects base state at position 0 when compaction removed todo parts', () => {
    const { deps, setHistory } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const t1 = makeTodo({ id: 'aaaa', description: 'Task A' });
    const t2 = makeTodo({ id: 'bbbb', description: 'Task B' });

    // Full history: [msg1, todos#1, msg3, todos#2, summary, msg6, todos#3, msg7]
    const msg1 = createTextMessage('user', 'Start');
    const todos1 = createTodosMessage([t1]);
    const msg3 = createTextMessage('assistant', 'Set A');
    const todos2 = createTodosMessage([t1, t2]);
    const summary = createSummaryMessage('Summary of earlier');
    const msg6 = createTextMessage('user', 'After compaction');
    const todos3 = createTodosMessage([t2]);
    const msg7 = createTextMessage('assistant', 'Cleared A');

    const fullHistory = [
      msg1,
      todos1,
      msg3,
      todos2,
      summary,
      msg6,
      todos3,
      msg7,
    ];
    // Compacted history (what the transformer receives): [summary, msg6, todos#3, msg7]
    const compactedHistory = [summary, msg6, todos3, msg7];

    setHistory(fullHistory);

    const result = ext.historyTransformer?.(
      compactedHistory,
      {} as never,
    ) as ExtendedUIMessage[];

    // Should have 5 messages: injected base state + 4 compacted messages
    expect(result).toHaveLength(5);

    // Position 0: injected full list from todos#2 (state = [t1, t2])
    const injected = result[0]!;
    expect(injected.role).toBe('user');
    const injectedText = extractTextParts(injected);
    expect(injectedText).toContain('<todos>');
    expect(injectedText).toContain('aaaa');
    expect(injectedText).toContain('bbbb');
    expect(injectedText).toContain('Task A');
    expect(injectedText).toContain('Task B');

    // Position 1: summary (unchanged)
    expect(result[1]).toBe(summary);

    // Position 2: msg6 (unchanged)
    expect(result[2]).toBe(msg6);

    // Position 3: todos#3 replaced with diff([t1,t2] → [t2]) = cleared aaaa
    const diffText = extractTextParts(result[3]!);
    expect(diffText).toContain('Todo cleared');
    expect(diffText).toContain('aaaa');
    expect(diffText).not.toContain('<todos>');

    // Position 4: msg7 (unchanged)
    expect(result[4]).toBe(msg7);
  });

  it('historyTransformer injects base state when ALL todo parts were compacted away', () => {
    const { deps, setHistory } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const t1 = makeTodo({ id: 'aaaa', description: 'Task A' });
    const t2 = makeTodo({ id: 'bbbb', description: 'Task B' });

    const msg1 = createTextMessage('user', 'Start');
    const todos1 = createTodosMessage([t1, t2]);
    const msg2 = createTextMessage('assistant', 'Set both');
    const summary = createSummaryMessage('Summary');
    const msg3 = createTextMessage('user', 'After compaction');
    const msg4 = createTextMessage('assistant', 'Response');

    const fullHistory = [msg1, todos1, msg2, summary, msg3, msg4];
    // Compacted: no todo parts survive
    const compactedHistory = [summary, msg3, msg4];

    setHistory(fullHistory);

    const result = ext.historyTransformer?.(
      compactedHistory,
      {} as never,
    ) as ExtendedUIMessage[];

    // Injected base state + 3 compacted messages
    expect(result).toHaveLength(4);
    const injectedText = extractTextParts(result[0]!);
    expect(injectedText).toContain('<todos>');
    expect(injectedText).toContain('aaaa');
    expect(injectedText).toContain('bbbb');
    // Rest unchanged
    expect(result[1]).toBe(summary);
    expect(result[2]).toBe(msg3);
    expect(result[3]).toBe(msg4);
  });

  it('historyTransformer handles empty todos list in a data part', () => {
    const { deps, setHistory } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const t1 = makeTodo({ id: 'aaaa', description: 'Task A' });

    const history = [
      createTodosMessage([t1]),
      createTextMessage('assistant', 'Set'),
      createTodosMessage([]), // cleared all
    ];
    setHistory(history);

    const result = ext.historyTransformer?.(
      history,
      {} as never,
    ) as ExtendedUIMessage[];

    // Part 0: full list with t1
    const text1 = extractTextParts(result[0]!);
    expect(text1).toContain('aaaa');
    // Part 2: diff — cleared t1
    const text2 = extractTextParts(result[2]!);
    expect(text2).toContain('Todo cleared');
    expect(text2).toContain('aaaa');
  });

  // -------------------------------------------------------------------------
  // dataPartTransformers (fallback)
  // -------------------------------------------------------------------------

  it('dataPartTransformers produces full list text for the todos key', () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const transformers = ext.dataPartTransformers;
    if (!transformers) throw new Error('No dataPartTransformers');
    const transformer = transformers[TODOS_KEY];
    if (!transformer) throw new Error(`No transformer for ${TODOS_KEY}`);

    const t1 = makeTodo({ id: 'aaaa', description: 'Task A' });
    const result = transformer({ todos: [t1] } as TodosDataUIPart);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('text');
    expect((result[0] as { text: string }).text).toContain('<todos>');
    expect((result[0] as { text: string }).text).toContain(
      '1. (ID: aaaa) Task A',
    );
  });

  it('dataPartTransformers handles empty todos list', () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const transformers = ext.dataPartTransformers;
    if (!transformers) throw new Error('No dataPartTransformers');
    const transformer = transformers[TODOS_KEY];
    if (!transformer) throw new Error(`No transformer for ${TODOS_KEY}`);

    const result = transformer({ todos: [] } as TodosDataUIPart);
    expect(result).toHaveLength(1);
    expect((result[0] as { text: string }).text).toBe('<todos>\n</todos>');
  });

  // -------------------------------------------------------------------------
  // introspect
  // -------------------------------------------------------------------------

  it('introspect returns todo count and todo entries', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    await callTool(ext, 'createTodo', {
      description: 'Test todo',
    });
    const state = introspect(ext);
    expect(state.todoCount).toBe(1);
    const todos = state.todos as Array<Record<string, unknown>>;
    expect(todos).toHaveLength(1);
    expect(todos[0]!.id).toBeTypeOf('string');
    expect(todos[0]!.description).toBe('Test todo');
  });

  it('introspect returns empty state when no todos are active', () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const state = introspect(ext);
    expect(state.todoCount).toBe(0);
    expect(state.todos).toEqual([]);
  });

  it('introspect returns todos in insertion order', async () => {
    const { deps } = createMockDeps();
    const ext = createTodosExt.create(deps);
    const r1 = await callTool(ext, 'createTodo', {
      description: 'First',
    });
    await callTool(ext, 'createTodo', { description: 'Second' });
    await callTool(ext, 'createTodo', {
      description: 'After First',
      after: r1.id,
    });
    const state = introspect(ext);
    const todos = state.todos as Array<Record<string, unknown>>;
    expect(todos).toHaveLength(3);
    expect(todos[0]!.description).toBe('First');
    expect(todos[1]!.description).toBe('After First');
    expect(todos[2]!.description).toBe('Second');
  });
});
