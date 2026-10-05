import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    const restarted = await setup({ dataDir, logger: silentMachineLogger });
    expect(restarted.pending('first').events[0]).toMatchObject({
      eventId: watcherLostEvent(record.info, record.info.createdAt).eventId,
      type: 'watcher.lost',
    });
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
