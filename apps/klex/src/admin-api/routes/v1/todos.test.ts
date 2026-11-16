import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTodoList,
  MAX_TODOS,
  type TodoList,
} from '@/session/chat/extensions/todos/todo-list';

import { setupTestApp } from './test-utils';
import {
  createTodo,
  createTodoRoute,
  deleteTodo,
  deleteTodoRoute,
  listTodos,
  listTodosRoute,
  updateTodo,
  updateTodoRoute,
} from './todos';

const FUTURE = '2099-01-01T09:00:00.000Z';
const PAST = '2000-01-01T09:00:00.000Z';

const temporaryDirectories: string[] = [];

function createRunningList(running = true) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'todos-route-test-'));
  temporaryDirectories.push(dataDirectory);
  const todoList = createTodoList();
  todoList.bind(dataDirectory);
  if (running) todoList.attach(() => undefined);
  return todoList;
}

function createApp(todoList: TodoList) {
  return setupTestApp((app) => {
    app.openapi(listTodosRoute, listTodos({ todoList }));
    app.openapi(createTodoRoute, createTodo({ todoList }));
    app.openapi(updateTodoRoute, updateTodo({ todoList }));
    app.openapi(deleteTodoRoute, deleteTodo({ todoList }));
  });
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('todos routes', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lists todos in order', async () => {
    const todoList = createRunningList();
    const first = await todoList.create({
      description: 'First',
      reminderTime: null,
    });
    const second = await todoList.create({
      description: 'Second',
      reminderTime: FUTURE,
    });

    const res = await createApp(todoList).request('/v1/todos');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ todos: [first.todo, second.todo] });
  });

  it('creates a todo with and without a reminder', async () => {
    const todoList = createRunningList();
    const app = createApp(todoList);

    const plain = await app.request(
      '/v1/todos',
      json('POST', { description: '  Follow up with Ana  ' }),
    );
    expect(plain.status).toBe(201);
    expect(await plain.json()).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{4}$/),
      description: 'Follow up with Ana',
      reminderTime: null,
    });

    const reminded = await app.request(
      '/v1/todos',
      json('POST', { description: 'Renew domain', reminderTime: FUTURE }),
    );
    expect(reminded.status).toBe(201);
    expect(await reminded.json()).toMatchObject({ reminderTime: FUTURE });
    expect(await todoList.list()).toHaveLength(2);
  });

  it.each([
    ['an empty description', { description: '   ' }],
    ['a description over 500 characters', { description: 'x'.repeat(501) }],
    ['a non-ISO reminder time', { description: 'x', reminderTime: 'soon' }],
  ])('rejects %s', async (_label, body) => {
    const todoList = createRunningList();
    const res = await createApp(todoList).request(
      '/v1/todos',
      json('POST', body),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'validation_failed' });
    expect(await todoList.list()).toEqual([]);
  });

  it('rejects a reminder time in the past', async () => {
    const todoList = createRunningList();
    const res = await createApp(todoList).request(
      '/v1/todos',
      json('POST', { description: 'Too late', reminderTime: PAST }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'reminderTime must be in the future',
      code: 'reminder_in_past',
    });
    expect(await todoList.list()).toEqual([]);
  });

  it('returns 409 at the todo limit', async () => {
    const todoList = createRunningList();
    for (let i = 0; i < MAX_TODOS; i++) {
      await todoList.create({ description: `Todo ${i}`, reminderTime: null });
    }

    const res = await createApp(todoList).request(
      '/v1/todos',
      json('POST', { description: 'One too many' }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'todo_limit_reached' });
  });

  it('edits the description and reminder of a todo', async () => {
    const todoList = createRunningList();
    const { todo } = await todoList.create({
      description: 'Draft',
      reminderTime: FUTURE,
    });
    const app = createApp(todoList);

    const described = await app.request(
      `/v1/todos/${todo.id}`,
      json('PATCH', { description: 'Final' }),
    );
    expect(described.status).toBe(200);
    expect(await described.json()).toEqual({
      ...todo,
      description: 'Final',
    });

    const cleared = await app.request(
      `/v1/todos/${todo.id}`,
      json('PATCH', { reminderTime: null }),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      id: todo.id,
      description: 'Final',
      reminderTime: null,
    });
  });

  it.each([
    ['an empty edit', {}, 'validation_failed'],
    ['a past reminder time', { reminderTime: PAST }, 'reminder_in_past'],
  ])('rejects %s', async (_label, body, code) => {
    const todoList = createRunningList();
    const { todo } = await todoList.create({
      description: 'Unchanged',
      reminderTime: FUTURE,
    });

    const res = await createApp(todoList).request(
      `/v1/todos/${todo.id}`,
      json('PATCH', body),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code });
    expect(await todoList.list()).toEqual([todo]);
  });

  it('deletes a todo', async () => {
    const todoList = createRunningList();
    const { todo } = await todoList.create({
      description: 'Done',
      reminderTime: null,
    });

    const res = await createApp(todoList).request(`/v1/todos/${todo.id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: todo.id });
    expect(await todoList.list()).toEqual([]);
  });

  it.each([
    ['PATCH', json('PATCH', { description: 'x' })],
    ['DELETE', { method: 'DELETE' }],
  ])('returns 404 for %s of an unknown todo', async (_method, init) => {
    const res = await createApp(createRunningList()).request(
      '/v1/todos/zzzz',
      init,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Todo zzzz not found',
      code: 'todo_not_found',
    });
  });

  it.each([
    ['GET', '/v1/todos', { method: 'GET' }],
    ['POST', '/v1/todos', json('POST', { description: 'x' })],
    ['PATCH', '/v1/todos/abcd', json('PATCH', { description: 'x' })],
    ['DELETE', '/v1/todos/abcd', { method: 'DELETE' }],
  ])(
    'returns 503 for %s while the extension is not running',
    async (_method, path, init) => {
      const res = await createApp(createRunningList(false)).request(path, init);

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'not_running' });
    },
  );

  it('returns 500 when the store fails', async () => {
    const todoList = createRunningList();
    vi.spyOn(todoList, 'list').mockRejectedValueOnce(new Error('disk failed'));

    const res = await createApp(todoList).request('/v1/todos');

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'internal_error' });
  });

  it('appears in the OpenAPI document', () => {
    const document = createApp(createRunningList()).getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
    });

    expect(document.paths['/v1/todos']?.get).toBeDefined();
    expect(document.paths['/v1/todos']?.post).toBeDefined();
    expect(document.paths['/v1/todos/{id}']?.patch).toBeDefined();
    expect(document.paths['/v1/todos/{id}']?.delete).toBeDefined();
  });
});
