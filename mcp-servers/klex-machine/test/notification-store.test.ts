import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { silentMachineLogger } from '../src/logger.js';
import {
  createNotificationStore,
  type NotificationStore,
  PENDING_EVENT_TTL_MS,
  type TrackedItem,
  watcherCompletedEvent,
  watcherLostEvent,
} from '../src/notifications/index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
  };
});

const stores: NotificationStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup(
  options: Parameters<typeof createNotificationStore>[0] = {
    logger: silentMachineLogger,
  },
) {
  const store = createNotificationStore(options);
  stores.push(store);
  await store.ready();
  return store;
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'machine-notifications-'));
  dirs.push(dir);
  return dir;
}
function item(
  id: string,
  principalId = 'first',
  now = Date.now(),
): TrackedItem & { kind: 'watcher' } {
  return {
    id,
    principalId,
    kind: 'watcher',
    info: {
      watcherId: id,
      title: id,
      command: 'exit 0',
      cwd: process.cwd(),
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 10000).toISOString(),
    },
  };
}
async function complete(store: NotificationStore, record = item('one')) {
  await store.track(record);
  const event = watcherCompletedEvent(record.info, {
    outcome: 'condition_met',
    exitCode: 0,
    signal: null,
    finishedAt: record.info.createdAt,
    output: '',
  });
  await store.complete(record.id, event);
  return event;
}

describe('notification store', () => {
  it('persists before notifying and restores pending events unchanged', async () => {
    const dataDir = await directory();
    const store = await setup({ dataDir, logger: silentMachineLogger });
    let disk: Promise<string> | undefined;
    store.onEvent('first', () => {
      disk = readFile(join(dataDir, 'notifications/state.json'), 'utf8');
    });
    const event = await complete(store);
    expect(await disk).toContain(event.eventId);
    await store.close();
    const restored = await setup({ dataDir, logger: silentMachineLogger });
    expect(restored.pending('first').events).toEqual([event]);
  });
  it('acknowledges idempotently and only for the owning principal', async () => {
    const store = await setup();
    const event = await complete(store);
    await store.acknowledge('second', [event.eventId]);
    expect(store.pending('first').events).toHaveLength(1);
    await store.acknowledge('first', [event.eventId]);
    await store.acknowledge('first', [event.eventId]);
    expect(store.pending('first').events).toEqual([]);
  });
  it('pages, clones, and rejects new items after 256 pending events', async () => {
    const store = await setup();
    for (let index = 0; index < 256; index++)
      await complete(store, item(String(index)));
    const page = store.pending('first', 3);
    expect(page.events).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    if (page.events[0]) page.events[0].type = 'modified';
    expect(store.pending('first').events[0]?.type).toBe('watcher.completed');
    await expect(store.track(item('extra'))).rejects.toThrow(
      'Too many unacknowledged',
    );
    await expect(store.track(item('other', 'second'))).resolves.toBeUndefined();
  });
  it('converts running records into restart-loss notifications', async () => {
    const dataDir = await directory();
    const store = await setup({ dataDir, logger: silentMachineLogger });
    const record = item('lost');
    await store.track(record);
    await store.close();
    const restartedAt = Date.now() + 1000;
    const restarted = await setup({
      dataDir,
      logger: silentMachineLogger,
      now: () => restartedAt,
    });
    expect(restarted.pending('first').events[0]).toEqual(
      watcherLostEvent(record.info, new Date(restartedAt).toISOString()),
    );
  });
  it('does not persist a rejected track in a later concurrent snapshot', async () => {
    const dataDir = await directory();
    const store = await setup({ dataDir, logger: silentMachineLogger });
    vi.mocked(rename).mockRejectedValueOnce(new Error('write failed'));
    const results = await Promise.allSettled([
      store.track(item('rejected')),
      store.track(item('accepted')),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'fulfilled',
    ]);
    expect(store.records('first').map((record) => record.id)).toEqual([
      'accepted',
    ]);
    await store.close();
    const restarted = await setup({ dataDir, logger: silentMachineLogger });
    expect(restarted.records('first').map((record) => record.id)).toEqual([
      'accepted',
    ]);
  });
  it.each(['forget', 'acknowledge'] as const)(
    'serializes failed %s rollback before a later write',
    async (operation) => {
      const dataDir = await directory();
      const store = await setup({ dataDir, logger: silentMachineLogger });
      const event = await complete(store);
      vi.mocked(rename).mockRejectedValueOnce(new Error('write failed'));
      const results = await Promise.allSettled([
        operation === 'forget'
          ? store.forget('one')
          : store.acknowledge('first', [event.eventId]),
        store.track(item('later')),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        'fulfilled',
      ]);
      expect(store.pending('first').events).toEqual([event]);
      await store.close();
      const restarted = await setup({ dataDir, logger: silentMachineLogger });
      expect(restarted.pending('first').events).toContainEqual(event);
    },
  );
  it('allows only one concurrent startup to own a new state directory', async () => {
    const dataDir = await directory();
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () =>
        setup({ dataDir, logger: silentMachineLogger }),
      ),
    );
    expect(contenders.filter((store) => store.persistent)).toHaveLength(1);
  });
  it('does not steal a lock while its owner is publishing the PID', async () => {
    const dataDir = await directory();
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await gate.promise;
        return write(...args);
      });
      return handle;
    });
    const first = setup({ dataDir, logger: silentMachineLogger });
    await entered.promise;
    try {
      const contender = await setup({ dataDir, logger: silentMachineLogger });
      expect(contender.persistent).toBe(false);
      expect(await readFile(join(dataDir, 'notifications/lock'), 'utf8')).toBe(
        '',
      );
    } finally {
      gate.resolve();
    }
    expect((await first).persistent).toBe(true);
  });
  it.each(['', 'invalid', '2147483647partial'])(
    'does not reclaim an unpublished or invalid PID lock (%j)',
    async (lock) => {
      const dataDir = await directory();
      const first = await setup({ dataDir, logger: silentMachineLogger });
      await first.close();
      const lockPath = join(dataDir, 'notifications/lock');
      await writeFile(lockPath, lock);
      const contender = await setup({ dataDir, logger: silentMachineLogger });
      expect(contender.persistent).toBe(false);
      expect(await readFile(lockPath, 'utf8')).toBe(lock);
    },
  );
  it('reclaims a complete lock owned by a dead process', async () => {
    const dataDir = await directory();
    const first = await setup({ dataDir, logger: silentMachineLogger });
    await first.close();
    await writeFile(join(dataDir, 'notifications/lock'), '2147483647\n');
    const restarted = await setup({ dataDir, logger: silentMachineLogger });
    expect(restarted.persistent).toBe(true);
  });
  it('does not let a delayed stale-lock reclaimer delete a replacement lock', async () => {
    const dataDir = await directory();
    const first = await setup({ dataDir, logger: silentMachineLogger });
    await first.close();
    const lockPath = join(dataDir, 'notifications/lock');
    await writeFile(lockPath, '2147483647\n');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    vi.mocked(readFile).mockImplementationOnce(async (...args) => {
      const value = await actual.readFile(...args);
      entered.resolve();
      await gate.promise;
      return value;
    });
    const delayed = setup({ dataDir, logger: silentMachineLogger });
    await entered.promise;
    let replacement: NotificationStore;
    try {
      replacement = await setup({ dataDir, logger: silentMachineLogger });
      expect(replacement.persistent).toBe(true);
    } finally {
      gate.resolve();
    }
    expect((await delayed).persistent).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid}\n`);
  });
  it('does not remove another stale-lock recovery guard', async () => {
    const dataDir = await directory();
    const first = await setup({ dataDir, logger: silentMachineLogger });
    await first.close();
    await writeFile(join(dataDir, 'notifications/lock'), '2147483647\n');
    await mkdir(join(dataDir, 'notifications/lock-recovery'));
    const contender = await setup({ dataDir, logger: silentMachineLogger });
    expect(contender.persistent).toBe(false);
    expect(await readdir(join(dataDir, 'notifications'))).toContain(
      'lock-recovery',
    );
  });
  it('drops expired pending events with a warning', async () => {
    let now = Date.now();
    const warn = vi.fn();
    const store = await setup({
      logger: { ...silentMachineLogger, warn },
      now: () => now,
    });
    await complete(store, item('expired', 'first', now));
    now += PENDING_EVENT_TTL_MS + 1;
    expect(store.pending('first').events).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
  it('quarantines corrupt state and handles live and stale locks', async () => {
    const dataDir = await directory();
    const first = await setup({ dataDir, logger: silentMachineLogger });
    const warn = vi.fn();
    const concurrent = await setup({
      dataDir,
      logger: { ...silentMachineLogger, warn },
    });
    expect(concurrent.persistent).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    await first.close();
    await writeFile(join(dataDir, 'notifications/lock'), '2147483647\n');
    await writeFile(join(dataDir, 'notifications/state.json'), '{broken');
    const recovered = await setup({ dataDir, logger: silentMachineLogger });
    expect(recovered.persistent).toBe(true);
    expect(await readdir(join(dataDir, 'notifications'))).toContainEqual(
      expect.stringMatching(/state.json.corrupt-/),
    );
  });
});
