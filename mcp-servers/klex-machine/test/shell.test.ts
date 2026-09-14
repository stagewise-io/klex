import { mkdtemp, rm } from 'node:fs/promises';
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
  await rm(directory, { force: true, recursive: true });
});

describe('ShellService', () => {
  it('keeps a PTY alive across writes and cursor reads', async () => {
    const session = service.create(testShell());
    service.write(session.id, command('printf first', "Write-Output 'first'"));
    const first = await readUntil(service, session.id, 0, 'first');
    service.write(
      session.id,
      command('printf second', "Write-Output 'second'"),
    );
    const second = await readUntil(service, session.id, first.cursor, 'second');
    expect(second.output).not.toContain('first');
    expect(service.list()).toHaveLength(1);
  });

  it('starts in the configured cwd including paths with spaces', async () => {
    const session = service.create(testShell());
    service.write(session.id, command('pwd', '(Get-Location).Path'));
    const result = await readUntil(service, session.id, 0, directory);
    expect(result.output).toContain(directory);
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

  it('validates resize and unknown sessions', () => {
    const session = service.create(testShell());
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
