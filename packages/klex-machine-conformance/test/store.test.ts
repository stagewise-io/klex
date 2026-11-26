import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  implementation,
  type Machine,
  PUSH,
  startMachine,
  temporaryDirectory,
  waitFor,
  windows,
} from '../src/harness.js';

interface PushEvent {
  eventId: string;
  type: string;
  data: Record<string, unknown>;
}

const push = { push: true };
const longCommand = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;

async function events(machine: Machine): Promise<PushEvent[]> {
  const { result } = await machine.rpc<{ events: PushEvent[] }>(
    `${PUSH}/get`,
    {},
    push,
  );
  return result?.events ?? [];
}

async function completedWatcher(machine: Machine): Promise<PushEvent> {
  await machine.tool(
    'createWatcher',
    { command: 'echo persisted', title: 'persisted', timeoutMs: 10_000 },
    push,
  );
  return waitFor(async () => (await events(machine))[0]);
}

describe('notification state', () => {
  it('restores pending events after a restart', async () => {
    const dataDir = await temporaryDirectory();
    const first = await startMachine({ dataDir });
    const event = await completedWatcher(first);
    await first.stop();
    const second = await startMachine({ dataDir });
    expect(await events(second)).toEqual([event]);
  });

  it('turns watchers running at a crash into restart-loss events', async () => {
    const dataDir = await temporaryDirectory();
    const first = await startMachine({ dataDir });
    const created = await first.tool<{ id: string }>(
      'createWatcher',
      { command: longCommand, title: 'lost', timeoutMs: 60_000 },
      push,
    );
    await first.stop('SIGKILL');
    const second = await startMachine({ dataDir });
    const [event] = await events(second);
    expect(event).toMatchObject({
      eventId: `watcher:${created.id}:lost`,
      type: 'watcher.lost',
      data: { watcherId: created.id, title: 'lost' },
    });
  });

  it.runIf(implementation === 'rust')(
    'takes over a data directory written by the TypeScript server',
    async () => {
      const dataDir = await temporaryDirectory();
      const typescript = await startMachine({ dataDir, implementation: 'ts' });
      const event = await completedWatcher(typescript);
      await typescript.stop();
      const rust = await startMachine({ dataDir });
      expect(await events(rust)).toEqual([event]);
    },
  );

  it('runs without persistence while another process owns the data directory', async () => {
    const dataDir = await temporaryDirectory();
    const first = await startMachine({ dataDir });
    const second = await startMachine({ dataDir });
    expect(second.logs).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        message:
          'Notification state is locked or its owner is unknown; notifications are memory-only',
        lockPath: join(dataDir, 'notifications', 'lock'),
      }),
    );
    await completedWatcher(second);
    await first.stop();
    const third = await startMachine({ dataDir });
    expect(await events(third)).toEqual([]);
  });

  it.skipIf(windows)(
    'quarantines corrupt state and reclaims stale locks',
    async () => {
      const dataDir = await temporaryDirectory();
      const first = await startMachine({ dataDir });
      await first.stop();
      await writeFile(join(dataDir, 'notifications/lock'), '2147483647\n');
      await writeFile(join(dataDir, 'notifications/state.json'), '{broken');
      const second = await startMachine({ dataDir });
      expect(await readdir(join(dataDir, 'notifications'))).toContainEqual(
        expect.stringMatching(/^state\.json\.corrupt-/),
      );
      await completedWatcher(second);
      await waitFor(async () => {
        const state = await readFile(
          join(dataDir, 'notifications/state.json'),
          'utf8',
        );
        return state.includes('watcher.completed') ? true : undefined;
      });
    },
  );
});
