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

/**
 * Waits until `text` is on disk; events are readable before they are persisted.
 * On Windows, Node's rename fails while another handle has the target open, and
 * the TypeScript store does not retry a failed write. So state.json is only read
 * while no temporary state file shows a write in flight.
 */
async function persisted(machine: Machine, text: string): Promise<void> {
  const directory = join(machine.dataDir, 'notifications');
  try {
    await waitFor(async () => {
      const entries = await readdir(directory).catch(() => []);
      if (entries.some((entry) => entry.endsWith('.tmp'))) return undefined;
      const state = await readFile(join(directory, 'state.json'), 'utf8').catch(
        () => '',
      );
      return state.includes(text) ? true : undefined;
    });
  } catch (error) {
    const logs = machine.logs.map((record) => JSON.stringify(record));
    throw new Error(
      `${text} never reached state.json. Server log:\n${logs.join('\n')}`,
      {
        cause: error,
      },
    );
  }
}

describe('notification state', () => {
  it('restores pending events after a restart', async () => {
    const dataDir = await temporaryDirectory();
    const first = await startMachine({ dataDir });
    const event = await completedWatcher(first);
    // Windows has no SIGTERM handler, so stop() kills the process outright.
    await persisted(first, event.eventId);
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
      await persisted(typescript, event.eventId);
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

  it('quarantines corrupt state and reclaims stale locks', async () => {
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
    await persisted(second, 'watcher.completed');
  });
});
