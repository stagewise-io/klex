import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MachinePathResolver } from '../src/filesystem/paths.js';
import { ShellService } from '../src/shell/service.js';

let directory: string;
let service: ShellService;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'klex machine shell '));
  service = new ShellService(new MachinePathResolver(directory));
});

afterEach(async () => {
  service.closeAll();
  await rm(directory, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
});

describe('ShellService', () => {
  it('keeps a PTY alive across writes and cursor reads', async () => {
    const session = service.create(testShell());
    service.write(session.id, command('printf first', 'echo first'));
    const first = await readUntilIdle(service, session.id, 0, 'first');
    service.write(session.id, command('printf second', 'echo second'));
    const second = await readUntilIdle(
      service,
      session.id,
      first.cursor,
      'second',
    );
    expect(second.output).not.toContain('first');
    expect(service.list()).toHaveLength(1);
  });

  it('starts in the configured cwd including paths with spaces', async () => {
    const session = service.create(testShell());
    service.write(session.id, command('pwd', 'cd'));
    const result = await readUntil(service, session.id, 0, directory);
    const reported = result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line === directory);
    expect(reported).toBeDefined();
    await expect(realpath(reported ?? '')).resolves.toBe(
      await realpath(directory),
    );
  });

  it('reports exit state and permits explicit cleanup', async () => {
    const session = service.create(testShell());
    service.write(session.id, command('exit 7', 'exit 7'));
    let result = await service.read({ id: session.id, waitMs: 1000 });
    for (let attempt = 0; attempt < 10 && result.running; attempt += 1) {
      result = await service.read({
        id: session.id,
        cursor: result.cursor,
        waitMs: 300,
      });
    }
    expect(result).toMatchObject({ running: false, exitCode: 7 });
    service.close(session.id);
    expect(() => service.write(session.id, 'x')).toThrow(
      'Unknown shell session',
    );
  });

  it('reclaims exited sessions and rejects running-session exhaustion', async () => {
    service.closeAll();
    service = new ShellService(new MachinePathResolver(directory), 2);
    const exited = service.create(testShell());
    service.write(exited.id, command('exit 0', 'exit 0'));
    let exitedRead = await service.read({ id: exited.id, waitMs: 1_000 });
    for (let attempt = 0; attempt < 10 && exitedRead.running; attempt += 1) {
      exitedRead = await service.read({
        id: exited.id,
        cursor: exitedRead.cursor,
        waitMs: 100,
      });
    }
    expect(exitedRead.running).toBe(false);

    service.create(testShell());
    service.create(testShell());
    expect(service.list()).toHaveLength(2);
    expect(() => service.write(exited.id, 'x')).toThrow('Unknown shell');
    expect(() => service.create(testShell())).toThrow('limit reached');
  });

  it('validates cursors, resize, and unknown sessions', async () => {
    const session = service.create(testShell());
    await expect(service.read({ id: session.id, cursor: 1 })).rejects.toThrow(
      'beyond',
    );
    expect(() => service.resize(session.id, 0, 20)).toThrow('cols');
    expect(() => service.resize('missing', 80, 20)).toThrow('Unknown shell');
    service.resize(session.id, 80, 20);
  });
});

function testShell(): { shell: string; args: string[] } {
  return process.platform === 'win32'
    ? { shell: process.env.ComSpec ?? 'powershell.exe', args: [] }
    : { shell: '/bin/sh', args: [] };
}

function command(posix: string, windows: string): string {
  return `${process.platform === 'win32' ? windows : posix}\r`;
}

async function readUntil(
  shell: ShellService,
  id: string,
  initialCursor: number,
  expected: string,
) {
  let cursor = initialCursor;
  let output = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await shell.read({ id, cursor, waitMs: 250 });
    output += result.output;
    cursor = result.cursor;
    if (output.includes(expected)) return { ...result, output, cursor };
  }
  throw new Error(
    `Timed out waiting for shell output: ${expected}; got ${output}`,
  );
}

async function readUntilIdle(
  shell: ShellService,
  id: string,
  initialCursor: number,
  expected: string,
) {
  let cursor = initialCursor;
  let output = '';
  let foundExpected = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await shell.read({ id, cursor, waitMs: 250 });
    output += result.output;
    cursor = result.cursor;
    foundExpected ||= output.includes(expected);
    if (foundExpected && result.output.length === 0) {
      return { ...result, output, cursor };
    }
  }
  throw new Error(
    `Timed out waiting for settled shell output: ${expected}; got ${output}`,
  );
}
