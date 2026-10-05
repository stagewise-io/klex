import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type PushNotification,
  registerPushNotificationsClient,
  withPushNotificationsClientCapability,
} from '@stagewise/mcp-extension-push-notifications';

import { silentMachineLogger } from '../src/logger.js';
import { createMachineMcp, type MachineMcp } from '../src/mcp.js';
import {
  createNotificationStore,
  type NotificationStore,
} from '../src/notifications/index.js';

const modules: MachineMcp[] = [];
const stores: NotificationStore[] = [];
const meta = withPushNotificationsClientCapability({});
afterEach(async () => {
  for (const mcp of modules.splice(0)) await mcp.close();
  for (const store of stores.splice(0)) await store.close();
});

function setup(principalId = 'local', shared?: NotificationStore) {
  const store =
    shared ?? createNotificationStore({ logger: silentMachineLogger });
  if (!shared) stores.push(store);
  const mcp = createMachineMcp(process.cwd(), {
    principalId,
    notifications: store,
  });
  modules.push(mcp);
  return { mcp, store };
}

function request(
  method: string,
  params: Record<string, unknown> = {},
  push = true,
) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, ...(push ? { _meta: meta } : {}) },
    }),
  });
}
interface RpcResponse {
  result?: {
    tools?: {
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    }[];
    content?: { text: string }[];
    isError?: boolean;
    events?: PushNotification[];
  };
  error?: { message: string };
}
async function rpc(
  mcp: MachineMcp,
  method: string,
  params: Record<string, unknown> = {},
  push = true,
): Promise<RpcResponse> {
  const response = await mcp.fetch(request(method, params, push));
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  return JSON.parse(data ?? text);
}
async function call(
  mcp: MachineMcp,
  name: string,
  args: Record<string, unknown>,
  push = true,
): Promise<{ id: string }> {
  const response = await rpc(
    mcp,
    'tools/call',
    { name, arguments: args },
    push,
  );
  expect(response.error).toBeUndefined();
  expect(response.result?.isError).not.toBe(true);
  return JSON.parse(response.result?.content?.[0]?.text ?? 'null');
}
async function events(mcp: MachineMcp) {
  return (
    (await rpc(mcp, 'io.stagewise/push-notifications/get')).result?.events ?? []
  );
}

describe('machine push notifications', () => {
  it('advertises watcher tools and notifyOnExit only for explicit push capability', async () => {
    const { mcp } = setup();
    const supported = (await rpc(mcp, 'tools/list')).result?.tools ?? [];
    const unsupported =
      (await rpc(mcp, 'tools/list', {}, false)).result?.tools ?? [];
    expect(supported.map((tool) => tool.name)).toEqual([
      'createWatcher',
      'listWatchers',
      'cancelWatcher',
      ...unsupported.map((tool) => tool.name),
    ]);
    expect(unsupported).toHaveLength(15);
    expect(
      supported.find((tool) => tool.name === 'createShellSession')?.inputSchema
        .properties,
    ).toHaveProperty('notifyOnExit');
    expect(
      unsupported.find((tool) => tool.name === 'createShellSession')
        ?.inputSchema.properties,
    ).not.toHaveProperty('notifyOnExit');
    const rejected = await rpc(
      mcp,
      'tools/call',
      {
        name: 'createWatcher',
        arguments: {
          command: 'exit 0',
          title: 'unsupported',
          timeoutMs: 10000,
        },
      },
      false,
    );
    expect(
      rejected.error?.message ?? rejected.result?.content?.[0]?.text,
    ).toMatch(/not found|unknown tool/i);
    const listed = await rpc(mcp, 'tools/call', {
      name: 'listWatchers',
      arguments: {},
    });
    expect(JSON.parse(listed.result?.content?.[0]?.text ?? 'null')).toEqual([]);
  });

  it.each([false, true])(
    'real SDK client carries the capability on listTools, push=%s',
    async (push) => {
      const { mcp } = setup();
      const client = new Client(
        { name: 'test', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      if (push) registerPushNotificationsClient(client);
      const transport = new StreamableHTTPClientTransport(
        new URL('http://localhost/mcp'),
        {
          fetch: (input, init) => mcp.fetch(new Request(input, init)),
        },
      );
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === 'createWatcher')).toBe(
          push,
        );
      } finally {
        await client.close();
      }
    },
  );

  it('queues completion, delivers live, and removes it on ack', async () => {
    const { mcp } = setup();
    const abort = new AbortController();
    const response = await mcp.fetch(
      new Request(
        request('subscriptions/listen', {
          notifications: { 'io.stagewise/push-notifications': {} },
        }),
        { signal: abort.signal },
      ),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    try {
      await reader?.read(); // subscription acknowledgement
      const created = await call(mcp, 'createWatcher', {
        command: 'echo watcher-ok',
        title: 'success',
        timeoutMs: 10000,
      });
      await expect.poll(async () => (await events(mcp)).length).toBe(1);
      const pending = await events(mcp);
      expect(pending[0]).toMatchObject({
        eventId: `watcher:${created.id}:completed`,
        type: 'watcher.completed',
        data: { outcome: 'condition_met' },
      });
      expect(pending[0]?.data?.outputTail).toContain('watcher-ok');
      const live = await reader?.read();
      expect(new TextDecoder().decode(live?.value)).toContain(
        'io.stagewise/push-notifications/event',
      );
      await rpc(mcp, 'io.stagewise/push-notifications/ack', {
        eventIds: pending.map((event) => event.eventId),
      });
      expect(await events(mcp)).toEqual([]);
    } finally {
      abort.abort();
      await reader?.cancel();
    }
  });

  it('ignores unsupported notifyOnExit and suppresses explicit shell close', async () => {
    const { mcp } = setup();
    const unsupported = await call(
      mcp,
      'createShellSession',
      {
        notifyOnExit: true,
        ...(process.platform === 'win32' ? {} : { shell: '/bin/sh', args: [] }),
      },
      false,
    );
    await call(mcp, 'writeShellSession', {
      id: unsupported.id,
      data: 'exit 0\r',
    });
    await expect
      .poll(async () => {
        const response = await rpc(mcp, 'tools/call', {
          name: 'listShellSessions',
          arguments: {},
        });
        const sessions: { id: string; running: boolean }[] = JSON.parse(
          response.result?.content?.[0]?.text ?? '[]',
        );
        return sessions.find((session) => session.id === unsupported.id)
          ?.running;
      })
      .toBe(false);
    expect(await events(mcp)).toEqual([]);
    const closed = await call(mcp, 'createShellSession', {
      notifyOnExit: true,
    });
    await call(mcp, 'closeShellSession', { id: closed.id });
    expect(await events(mcp)).toEqual([]);
    const supported = await call(mcp, 'createShellSession', {
      notifyOnExit: true,
      ...(process.platform === 'win32' ? {} : { shell: '/bin/sh', args: [] }),
    });
    await call(mcp, 'writeShellSession', {
      id: supported.id,
      data: 'exit 0\r',
    });
    await expect
      .poll(async () => (await events(mcp))[0]?.type)
      .toBe('shell.exited');
  });

  it('isolates shared-store events by principal', async () => {
    const { mcp: first, store } = setup('first');
    const { mcp: second } = setup('second', store);
    await call(first, 'createWatcher', {
      command: 'exit 0',
      title: 'private',
      timeoutMs: 10000,
    });
    await expect.poll(async () => (await events(first)).length).toBe(1);
    expect(await events(second)).toEqual([]);
  });

  it('passes malformed bodies to the SDK without consuming them', async () => {
    const { mcp } = setup();
    const response = await mcp.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: '{broken',
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
