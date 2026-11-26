import { describe, expect, it } from 'vitest';

import {
  events,
  type Machine,
  PUSH,
  startMachine,
  subscribe,
  waitFor,
  windows,
} from '../src/harness.js';

interface WatcherInfo {
  id: string;
  watcherId: string;
  title: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: string;
  createdAt: string;
  deadlineAt: string;
}

const push = { push: true };
const longCommand = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;

const firstEvent = (machine: Machine) =>
  waitFor(async () => (await events(machine))[0]);

describe('watchers and push notifications', () => {
  it.each([0, 3])(
    'reports watcher exit %i once as a pending event',
    async (code) => {
      const machine = await startMachine();
      const created = await machine.tool<WatcherInfo>(
        'createWatcher',
        {
          command: `echo watcher-out&& exit ${code}`,
          title: 'exit',
          timeoutMs: 10_000,
        },
        push,
      );
      expect(created).toMatchObject({
        watcherId: created.id,
        title: 'exit',
        cwd: machine.cwd,
        status: 'running',
      });
      expect(
        Date.parse(created.deadlineAt) - Date.parse(created.createdAt),
      ).toBe(10_000);
      const event = await firstEvent(machine);
      expect(event).toMatchObject({
        eventId: `watcher:${created.id}:completed`,
        type: 'watcher.completed',
        data: {
          watcherId: created.id,
          title: 'exit',
          outcome: code === 0 ? 'condition_met' : 'failed',
          exitCode: code,
        },
      });
      expect(event.data.outputTail).toContain('watcher-out');
      await new Promise((done) => setTimeout(done, 300));
      expect(await events(machine)).toHaveLength(1);
      await expect(machine.tool('listWatchers', {}, push)).resolves.toEqual([
        {
          ...created,
          pid: null,
          status: 'completed',
          outcome: code === 0 ? 'condition_met' : 'failed',
        },
      ]);
      await machine.rpc(`${PUSH}/ack`, { eventIds: [event.eventId] }, push);
      await expect(machine.tool('listWatchers', {}, push)).resolves.toEqual([]);
    },
  );

  it('delivers events live and removes them on acknowledgement', async () => {
    const machine = await startMachine();
    const stream = await subscribe(machine);
    try {
      expect(stream.response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const acknowledged = await stream.next();
      expect(acknowledged).toMatchObject({
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { notifications: { [PUSH]: {} } },
      });
      const created = await machine.tool<WatcherInfo>(
        'createWatcher',
        { command: 'echo watcher-ok', title: 'live', timeoutMs: 10_000 },
        push,
      );
      const live = await stream.next();
      expect(live).toMatchObject({
        method: `${PUSH}/event`,
        params: {
          event: {
            eventId: `watcher:${created.id}:completed`,
            data: { outcome: 'condition_met' },
          },
        },
      });
      const pending = await events(machine);
      expect(pending.map((event) => event.eventId)).toEqual([
        `watcher:${created.id}:completed`,
      ]);
      const ack = await machine.rpc(
        `${PUSH}/ack`,
        { eventIds: [pending[0]!.eventId, 'unknown'] },
        push,
      );
      expect(ack.error).toBeUndefined();
      expect(await events(machine)).toEqual([]);
    } finally {
      await stream.close();
    }
  });

  it('cancels watchers without notifying and enforces cancel errors', async () => {
    const machine = await startMachine();
    const created = await machine.tool<WatcherInfo>(
      'createWatcher',
      { command: longCommand, title: 'long', timeoutMs: 60_000 },
      push,
    );
    const listed = await machine.tool<WatcherInfo[]>('listWatchers', {}, push);
    expect(listed).toEqual([created]);
    await expect(
      machine.tool('cancelWatcher', { id: created.id }, push),
    ).resolves.toEqual({ ok: true });
    await expect(machine.tool('listWatchers', {}, push)).resolves.toEqual([]);
    expect(
      await machine.toolError('cancelWatcher', { id: created.id }, push),
    ).toContain(created.id);
    await new Promise((done) => setTimeout(done, 300));
    expect(await events(machine)).toEqual([]);
  });

  it('times out watchers at their deadline', async () => {
    const machine = await startMachine();
    const created = await machine.tool<WatcherInfo>(
      'createWatcher',
      { command: longCommand, title: 'deadline', timeoutMs: 1000 },
      push,
    );
    const event = await waitFor(async () => (await events(machine))[0], {
      timeout: 15_000,
    });
    expect(event).toMatchObject({
      eventId: `watcher:${created.id}:completed`,
      data: { outcome: 'timed_out' },
    });
  });

  it('notifies on shell exit only when requested by a push-capable client', async () => {
    const machine = await startMachine();
    const shell = windows ? {} : { shell: '/bin/sh', args: [] };
    const plain = await machine.tool<{ id: string }>('createShellSession', {
      notifyOnExit: true,
      ...shell,
    });
    await machine.tool('writeShellSession', { id: plain.id, data: 'exit 0\r' });
    await waitFor(async () => {
      const sessions =
        await machine.tool<{ id: string; running: boolean }[]>(
          'listShellSessions',
        );
      return sessions.find((session) => session.id === plain.id)?.running ===
        false
        ? true
        : undefined;
    });
    expect(await events(machine)).toEqual([]);

    const closed = await machine.tool<{ id: string }>(
      'createShellSession',
      { notifyOnExit: true, ...shell },
      push,
    );
    await machine.tool('closeShellSession', { id: closed.id }, push);
    await new Promise((done) => setTimeout(done, 300));
    expect(await events(machine)).toEqual([]);

    const notified = await machine.tool<{ id: string }>(
      'createShellSession',
      { notifyOnExit: true, ...shell },
      push,
    );
    await machine.tool(
      'writeShellSession',
      { id: notified.id, data: 'exit 4\r' },
      push,
    );
    const event = await firstEvent(machine);
    expect(event).toMatchObject({
      eventId: `shell:${notified.id}:exited`,
      type: 'shell.exited',
      data: { sessionId: notified.id, exitCode: 4 },
    });
  });

  it('rejects push methods without the client capability', async () => {
    const machine = await startMachine();
    const get = await machine.rpc(`${PUSH}/get`, {}, { push: false });
    expect(get.error).toEqual({
      code: -32003,
      message: 'Missing required client capability',
      data: { requiredCapabilities: { extensions: { [PUSH]: {} } } },
    });
    const ack = await machine.rpc(`${PUSH}/ack`, {}, push);
    expect(ack.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('eventIds'),
    });
    const listen = await machine.rpc(
      'subscriptions/listen',
      { notifications: { [PUSH]: {} } },
      { push: false },
    );
    expect(listen.error).toMatchObject({ code: -32003 });
    const invalid = await machine.rpc(
      'subscriptions/listen',
      { notifications: { [PUSH]: { extra: true } } },
      push,
    );
    expect(invalid.error).toEqual({
      code: -32602,
      message: 'Invalid Push Notifications subscription',
    });
  });

  it('replaces an earlier subscription and closes it gracefully', async () => {
    const machine = await startMachine();
    const first = await subscribe(machine);
    try {
      const firstAck = await first.next();
      const subscriptionId = (
        firstAck.params as { _meta: Record<string, unknown> }
      )._meta['io.modelcontextprotocol/subscriptionId'];
      expect(subscriptionId).toBeDefined();
      const second = await subscribe(machine);
      try {
        await second.next();
        const closed = await first.next();
        expect(closed).toMatchObject({
          jsonrpc: '2.0',
          id: subscriptionId,
          result: {
            resultType: 'complete',
            _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId },
          },
        });
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
});
