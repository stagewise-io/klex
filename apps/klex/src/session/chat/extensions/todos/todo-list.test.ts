import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTodoList, MAX_TODOS, TodoListError } from './todo-list';

const temporaryDirectories: string[] = [];

function createBoundList() {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'todo-list-test-'));
  temporaryDirectories.push(dataDirectory);
  const todoList = createTodoList();
  todoList.bind(dataDirectory);
  return { todoList, dataDirectory };
}

describe('TodoList', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates, updates and deletes todos and persists them', async () => {
    const { todoList, dataDirectory } = createBoundList();
    const { todo } = await todoList.create({
      description: 'Ship it',
      reminderTime: null,
    });
    expect(todo).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{4}$/),
      description: 'Ship it',
      reminderTime: null,
    });

    const updated = await todoList.update(todo.id, {
      reminderTime: '2099-01-01T00:00:00Z',
    });
    expect(updated.todo).toEqual({
      ...todo,
      reminderTime: '2099-01-01T00:00:00Z',
    });

    const reloaded = createTodoList();
    reloaded.bind(dataDirectory);
    expect(await reloaded.list()).toEqual([updated.todo]);

    expect(await todoList.delete(todo.id)).toEqual({
      deleted: true,
      todos: [],
    });
    expect(await todoList.delete(todo.id)).toEqual({
      deleted: false,
      todos: [],
    });
  });

  it('reports unknown IDs without writing a change', async () => {
    const { todoList } = createBoundList();
    expect(await todoList.update('zzzz', { description: 'x' })).toEqual({
      todo: null,
      todos: [],
    });
  });

  it('notifies attached listeners after each committed write', async () => {
    const { todoList } = createBoundList();
    const listener = vi.fn();
    const detach = todoList.attach(listener);
    expect(todoList.isAvailable()).toBe(true);

    const { todo } = await todoList.create({
      description: 'Notify me',
      reminderTime: null,
    });
    expect(listener).toHaveBeenLastCalledWith([todo]);

    detach();
    expect(todoList.isAvailable()).toBe(false);
    await todoList.delete(todo.id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify listeners of a rejected write', async () => {
    const { todoList } = createBoundList();
    for (let i = 0; i < MAX_TODOS; i++) {
      await todoList.create({ description: `Todo ${i}`, reminderTime: null });
    }
    const listener = vi.fn();
    todoList.attach(listener);

    await expect(
      todoList.create({ description: 'One too many', reminderTime: null }),
    ).rejects.toMatchObject({ code: 'todo_limit_reached' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects descriptions outside the stored limits', async () => {
    const { todoList } = createBoundList();
    await expect(
      todoList.create({ description: 'x'.repeat(501), reminderTime: null }),
    ).rejects.toBeInstanceOf(TodoListError);
    const { todo } = await todoList.create({
      description: 'ok',
      reminderTime: null,
    });
    await expect(
      todoList.update(todo.id, { description: '' }),
    ).rejects.toMatchObject({ code: 'invalid_todo' });
  });

  it('refuses to bind a second data directory', () => {
    const { todoList, dataDirectory } = createBoundList();
    expect(() => todoList.bind(dataDirectory)).not.toThrow();
    expect(() => todoList.bind(join(dataDirectory, 'other'))).toThrow(
      /already bound/,
    );
  });
});
