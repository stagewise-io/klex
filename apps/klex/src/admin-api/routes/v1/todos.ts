import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import {
  type TodoList,
  TodoListError,
} from '@/session/chat/extensions/todos/todo-list';

import {
  createTodoBodySchema,
  deleteTodoResponseSchema,
  errorResponseSchema,
  todoIdParamsSchema,
  todoListResponseSchema,
  todoSchema,
  updateTodoBodySchema,
} from './schemas';

export interface TodosRouteDependencies {
  todoList: TodoList;
}

const NOT_RUNNING = {
  error: 'Todos are not available because the todos extension is not running',
  code: 'not_running',
} as const;

const REMINDER_IN_PAST = {
  error: 'reminderTime must be in the future',
  code: 'reminder_in_past',
} as const;

const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: errorResponseSchema } },
  description,
});

const commonResponses = {
  500: errorResponse('Internal server error'),
  503: errorResponse('Todos extension is not running'),
};

function notFound(id: string) {
  return { error: `Todo ${id} not found`, code: 'todo_not_found' } as const;
}

function isPast(reminderTime: string | null | undefined): boolean {
  return (
    typeof reminderTime === 'string' && Date.parse(reminderTime) <= Date.now()
  );
}

export const listTodosRoute = createRoute({
  method: 'get',
  path: '/v1/todos',
  tags: ['Todos'],
  summary: 'List todos',
  description:
    "Lists the agent's active todos, shared by all of its sessions, in the order the agent sees them.",
  responses: {
    200: {
      content: { 'application/json': { schema: todoListResponseSchema } },
      description: 'Active todos',
    },
    ...commonResponses,
  },
});

export function listTodos(
  deps: TodosRouteDependencies,
): RouteHandler<typeof listTodosRoute> {
  return async (c) => {
    if (!deps.todoList.isAvailable()) return c.json(NOT_RUNNING, 503);
    return c.json({ todos: await deps.todoList.list() }, 200);
  };
}

export const createTodoRoute = createRoute({
  method: 'post',
  path: '/v1/todos',
  tags: ['Todos'],
  summary: 'Create a todo',
  description:
    'Appends a todo. The agent sees it on its next step, and a reminder is scheduled immediately. At most 100 todos can be active.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: createTodoBodySchema } },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: todoSchema } },
      description: 'Todo created',
    },
    400: errorResponse('Invalid todo or reminder time in the past'),
    409: errorResponse('Todo limit reached'),
    ...commonResponses,
  },
});

export function createTodo(
  deps: TodosRouteDependencies,
): RouteHandler<typeof createTodoRoute> {
  return async (c) => {
    if (!deps.todoList.isAvailable()) return c.json(NOT_RUNNING, 503);
    const { description, reminderTime } = c.req.valid('json');
    if (isPast(reminderTime)) return c.json(REMINDER_IN_PAST, 400);
    try {
      const { todo } = await deps.todoList.create({
        description,
        reminderTime: reminderTime ?? null,
      });
      return c.json(todo, 201);
    } catch (error) {
      if (!(error instanceof TodoListError)) throw error;
      if (error.code === 'todo_limit_reached')
        return c.json({ error: error.message, code: error.code }, 409);
      return c.json({ error: error.message, code: 'validation_failed' }, 400);
    }
  };
}

export const updateTodoRoute = createRoute({
  method: 'patch',
  path: '/v1/todos/{id}',
  tags: ['Todos'],
  summary: 'Edit a todo',
  description:
    'Changes the description and/or reminder time of a todo. A null `reminderTime` clears the reminder. The agent sees the change on its next step, and the reminder is rescheduled immediately.',
  request: {
    params: todoIdParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateTodoBodySchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: todoSchema } },
      description: 'Updated todo',
    },
    400: errorResponse('Invalid edit or reminder time in the past'),
    404: errorResponse('Todo not found'),
    ...commonResponses,
  },
});

export function updateTodo(
  deps: TodosRouteDependencies,
): RouteHandler<typeof updateTodoRoute> {
  return async (c) => {
    if (!deps.todoList.isAvailable()) return c.json(NOT_RUNNING, 503);
    const { id } = c.req.valid('param');
    const { description, reminderTime } = c.req.valid('json');
    if (isPast(reminderTime)) return c.json(REMINDER_IN_PAST, 400);
    try {
      const { todo } = await deps.todoList.update(id, {
        ...(description === undefined ? {} : { description }),
        ...(reminderTime === undefined ? {} : { reminderTime }),
      });
      if (!todo) return c.json(notFound(id), 404);
      return c.json(todo, 200);
    } catch (error) {
      if (!(error instanceof TodoListError)) throw error;
      return c.json({ error: error.message, code: 'validation_failed' }, 400);
    }
  };
}

export const deleteTodoRoute = createRoute({
  method: 'delete',
  path: '/v1/todos/{id}',
  tags: ['Todos'],
  summary: 'Delete a todo',
  description:
    'Clears a todo and cancels its reminder. The agent sees the change on its next step.',
  request: { params: todoIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteTodoResponseSchema } },
      description: 'Todo deleted',
    },
    404: errorResponse('Todo not found'),
    ...commonResponses,
  },
});

export function deleteTodo(
  deps: TodosRouteDependencies,
): RouteHandler<typeof deleteTodoRoute> {
  return async (c) => {
    if (!deps.todoList.isAvailable()) return c.json(NOT_RUNNING, 503);
    const { id } = c.req.valid('param');
    const { deleted } = await deps.todoList.delete(id);
    if (!deleted) return c.json(notFound(id), 404);
    return c.json({ deleted: true as const, id }, 200);
  };
}
