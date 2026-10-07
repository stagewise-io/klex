import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MachinePathResolver } from '../src/filesystem/paths.js';
import { CommandService } from '../src/shell/commands.js';
import { ShellService } from '../src/shell/service.js';
import { WorkloadTracker } from '../src/workloads/tracker.js';

let directory: string;
let workloads: WorkloadTracker;
let commands: CommandService;
let shells: ShellService;

beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'klex machine commands ')),
  );
  const paths = new MachinePathResolver(directory);
  workloads = new WorkloadTracker();
  commands = new CommandService(paths, workloads);
  shells = new ShellService(paths, undefined, workloads);
});

afterEach(async () => {
  commands.closeAll();
  shells.closeAll();
  workloads.close();
  await rm(directory, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
});

describe.skipIf(process.platform === 'win32')('CommandService', () => {
  it('protects a silent foreground command after the call returns', async () => {
    const started = await commands.run({
      command: 'sleep 0.4; echo done',
      waitMs: 0,
    });

    expect(started.status).toBe('running');
    expect(workloads.list()).toEqual([
      expect.objectContaining({ kind: 'command', subjectId: started.id }),
    ]);

    const finished = await readUntilDone(started.id);
    expect(finished).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(finished.output).toBe('done\n');
    expect(workloads.active).toBe(false);
  });

  it('reports non-zero exits and keeps output readable by cursor', async () => {
    const result = await commands.run({
      command: 'echo out; echo err >&2; exit 3',
      waitMs: 5_000,
    });

    expect(result).toMatchObject({ status: 'exited', exitCode: 3 });
    expect(result.output).toContain('out\n');
    expect(result.output).toContain('err\n');
    const tail = await commands.read({ id: result.id, cursor: result.cursor });
    expect(tail.output).toBe('');
  });

  it('never protects detached commands', async () => {
    const result = await commands.run({
      command: 'sleep 5',
      mode: 'detached',
      waitMs: 0,
    });

    expect(result.status).toBe('running');
    expect(workloads.active).toBe(false);
    commands.cancel(result.id);
    expect((await readUntilDone(result.id)).status).toBe('cancelled');
  });

  it('cancels the whole process group and releases protection', async () => {
    const marker = join(directory, 'grandchild');
    const result = await commands.run({
      command: `(sleep 1; echo alive > "${marker}") & wait`,
      waitMs: 0,
    });

    commands.cancel(result.id);
    expect((await readUntilDone(result.id)).status).toBe('cancelled');
    expect(workloads.active).toBe(false);
    await delay(1_300);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('stops leftover background processes when a foreground command exits', async () => {
    const marker = join(directory, 'leftover');
    const result = await commands.run({
      command: `(sleep 1; echo alive > "${marker}") & echo started`,
      waitMs: 5_000,
    });

    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
    await delay(1_300);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('times out foreground commands', async () => {
    const result = await commands.run({
      command: 'sleep 5',
      timeoutMs: 100,
      waitMs: 0,
    });

    expect((await readUntilDone(result.id)).status).toBe('timed_out');
    expect(workloads.active).toBe(false);
  });

  it('releases one command without clearing another', async () => {
    const short = await commands.run({ command: 'true', waitMs: 0 });
    const long = await commands.run({ command: 'sleep 5', waitMs: 0 });

    await readUntilDone(short.id);
    expect(workloads.list().map((workload) => workload.subjectId)).toEqual([
      long.id,
    ]);
  });

  it('rejects new commands only when every retained command is running', async () => {
    const limited = new CommandService(
      new MachinePathResolver(directory),
      workloads,
      1,
    );
    try {
      const first = await limited.run({ command: 'true', waitMs: 5_000 });
      const second = await limited.run({ command: 'sleep 5', waitMs: 0 });
      expect(limited.list().map((command) => command.id)).toEqual([second.id]);
      await expect(limited.run({ command: 'true' })).rejects.toThrow(
        'Command limit reached',
      );
      expect(first.status).toBe('exited');
    } finally {
      limited.closeAll();
    }
  });
});

describe.skipIf(process.platform === 'win32')('PTY protection', () => {
  it('is explicit, bounded and ends on close', async () => {
    const session = shells.create({ shell: '/bin/sh', args: [] });
    expect(workloads.active).toBe(false);

    const protection = shells.protect(session.id, 60_000);
    expect(Date.parse(protection.expiresAt)).toBeGreaterThan(Date.now());
    expect(workloads.list()).toEqual([
      expect.objectContaining({
        kind: 'shell-protection',
        subjectId: session.id,
        expiresAt: protection.expiresAt,
      }),
    ]);

    shells.protect(session.id, 120_000);
    expect(workloads.list()).toHaveLength(1);

    expect(() => shells.protect(session.id, 5 * 60 * 60 * 1000)).toThrow(
      'durationMs',
    );
    shells.close(session.id);
    expect(workloads.active).toBe(false);
  });

  it('expires without any shell activity', async () => {
    const session = shells.create({ shell: '/bin/sh', args: [] });
    shells.protect(session.id, 1_000);
    await delay(1_200);
    expect(workloads.active).toBe(false);
    expect(shells.list()[0]?.running).toBe(true);
  });
});

async function readUntilDone(id: string) {
  const deadline = Date.now() + 10_000;
  let cursor = 0;
  let output = '';
  for (;;) {
    const result = await commands.read({ id, cursor, waitMs: 500 });
    output += result.output;
    cursor = result.cursor;
    if (result.status !== 'running') return { ...result, output };
    if (Date.now() > deadline) throw new Error(`Command ${id} did not finish`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
