import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { AdmissionStatus, MaintenanceLease } from '@/admission';

import { SESSION_HISTORY_RELATIVE_PATH } from './schema';
import type { SessionHistoryMessagesPage, SessionHistoryRecord } from './types';

interface ChildMessage {
  type: string;
  error?: string;
  committed?: SessionHistoryMessagesPage;
  recovered?: SessionHistoryMessagesPage;
  session?: SessionHistoryRecord;
  lease?: MaintenanceLease;
  status?: AdmissionStatus;
  certified?: boolean;
  rejected?: boolean;
  epoch?: number;
}
const children: ChildProcess[] = [];
const directories: string[] = [];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'klex-crash-'));
  directories.push(path);
  return path;
}

function child(mode: string, path: string, lease?: MaintenanceLease) {
  const process = fork(
    fileURLToPath(new URL('./crash-recovery.fixture.ts', import.meta.url)),
    [mode, path, JSON.stringify(lease ?? {})],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.push(process);
  let stderr = '';
  process.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const messages: ChildMessage[] = [];
  const waiters: ((message: ChildMessage) => void)[] = [];
  process.on('message', (message: ChildMessage) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const exited = once(process, 'exit');
  return {
    process,
    exited,
    async next(): Promise<ChildMessage> {
      const queued = messages.shift();
      if (queued) return queued;
      return Promise.race([
        new Promise<ChildMessage>((resolve) => waiters.push(resolve)),
        exited.then(() => {
          throw new Error(`Child exited before IPC message: ${stderr}`);
        }),
      ]);
    },
  };
}

afterEach(async () => {
  for (const process of children.splice(0)) {
    if (process.exitCode !== null || process.signalCode !== null) continue;
    const exit = once(process, 'exit');
    process.kill('SIGKILL');
    await exit;
  }
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('process crash and admission recovery', () => {
  it('fences a live owner despite a stale PID marker timestamp, recovers after SIGKILL, and rejects a foreign same-epoch certificate', async () => {
    const path = await directory();
    const owner = child('owner', path);
    const ready = await owner.next();
    expect(ready.type).toBe('ready');
    expect(ready.status).toMatchObject({ state: 'draining', blockers: [] });
    expect(ready.status!.activeWork).toBeGreaterThan(0);
    expect(ready.certified).toBe(false);
    // Age is not ownership authority: a stale-looking timestamp must never
    // allow another process to steal a live owner's marker.
    const marker = JSON.parse(await readFile(join(path, '.klex.lock'), 'utf8'));
    await writeFile(
      join(path, '.klex.lock'),
      JSON.stringify({ ...marker, startedAt: '1970-01-01T00:00:00.000Z' }),
    );
    const competitor = child('recover', path, ready.lease);
    expect(await competitor.next()).toMatchObject({
      type: 'error',
      error: expect.stringContaining('already in use'),
    });
    expect((await competitor.exited)[0]).toBe(1);
    owner.process.send('status');
    expect(await owner.next()).toMatchObject({
      type: 'status',
      certified: false,
      status: { state: 'draining' },
    });
    owner.process.kill('SIGKILL');
    expect((await owner.exited)[1]).toBe('SIGKILL');
    expect(
      JSON.parse(await readFile(join(path, '.klex.lock'), 'utf8')).pid,
    ).toBe(owner.process.pid);
    const replacement = child('recover', path, ready.lease);
    const result = await replacement.next();
    expect(result.type).toBe('recovered');
    expect(result.recovered).toEqual(ready.committed);
    expect(result.recovered!.messages.map((entry) => entry.message.id)).toEqual(
      ['committed'],
    );
    expect(result.recovered!.messages[0]!.persistedAt).toBe(
      '2026-01-02T03:04:05.000Z',
    );
    expect(result.session).toMatchObject({
      ...ready.session,
      live: false,
      endedAt: ready.session!.updatedAt,
      endReason: 'unclean_shutdown',
    });
    expect(result.epoch).toBe(ready.lease!.epoch);
    expect(result.rejected).toBe(true);
    expect(result.status!.state).toBe('quiescent');
    expect((await replacement.exited)[0]).toBe(0);
  }, 20_000);

  it.each(['lock', 'store'] as const)(
    'fails closed on %s uncertainty before certification',
    async (kind) => {
      const path = await directory();
      const target = join(
        path,
        kind === 'lock' ? '.klex.lock' : SESSION_HISTORY_RELATIVE_PATH,
      );
      await writeFile(target, 'corrupt');
      const replacement = child('recover', path);
      const result = await replacement.next();
      expect(result.type).toBe('error');
      expect(result.status).toBeUndefined();
      expect((await replacement.exited)[0]).toBe(1);
      expect(await readFile(target, 'utf8')).toBe('corrupt');
    },
    10_000,
  );
});
