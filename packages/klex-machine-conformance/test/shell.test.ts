import { realpath } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  implementation,
  type Machine,
  startMachine,
  windows,
} from '../src/harness.js';

interface ShellInfo {
  id: string;
  shell: string;
  cwd: string;
  pid: number;
  running: boolean;
  createdAt: string;
  exitCode?: number;
  signal?: number;
}

interface ReadResult {
  id: string;
  output: string;
  cursor: number;
  truncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: number;
}

const testShell = (): Record<string, unknown> =>
  windows ? {} : { shell: '/bin/sh', args: [] };

const command = (posix: string, win: string) => `${windows ? win : posix}\r`;

async function readUntil(
  machine: Machine,
  id: string,
  cursor: number,
  expected: string,
): Promise<{ output: string; cursor: number }> {
  let output = '';
  let seen = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await machine.tool<ReadResult>('readShellSession', {
      id,
      cursor,
      waitMs: 250,
    });
    output += result.output;
    cursor = result.cursor;
    seen ||= output.includes(expected);
    if (seen && result.output.length === 0) return { output, cursor };
  }
  throw new Error(`Timed out waiting for ${expected}; got ${output}`);
}

async function readUntilExit(
  machine: Machine,
  id: string,
): Promise<ReadResult> {
  let result = await machine.tool<ReadResult>('readShellSession', {
    id,
    waitMs: 1000,
  });
  let output = result.output;
  for (let attempt = 0; attempt < 40 && result.running; attempt += 1) {
    result = await machine.tool<ReadResult>('readShellSession', {
      id,
      cursor: result.cursor,
      waitMs: 250,
    });
    output += result.output;
  }
  return { ...result, output };
}

describe('shell sessions', () => {
  it('keeps a PTY alive across writes and cursor reads', async () => {
    const machine = await startMachine();
    const session = await machine.tool<ShellInfo>(
      'createShellSession',
      testShell(),
    );
    expect(session).toMatchObject({
      cwd: machine.cwd,
      running: true,
    });
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(session.pid).toBeGreaterThan(0);
    await machine.tool('writeShellSession', {
      id: session.id,
      data: command('printf first', 'echo first'),
    });
    const first = await readUntil(machine, session.id, 0, 'first');
    await machine.tool('writeShellSession', {
      id: session.id,
      data: command('printf second', 'echo second'),
    });
    const second = await readUntil(machine, session.id, first.cursor, 'second');
    expect(second.output).not.toContain('first');
    const listed = await machine.tool<ShellInfo[]>('listShellSessions');
    expect(listed).toEqual([session]);
  });

  it('starts in the configured cwd including paths with spaces', async () => {
    const machine = await startMachine();
    const session = await machine.tool<ShellInfo>(
      'createShellSession',
      testShell(),
    );
    await machine.tool('writeShellSession', {
      id: session.id,
      data: command(
        "printf '__KLEX_CWD__'; pwd; printf '__KLEX_END__\\n'",
        'echo __KLEX_CWD__%CD%__KLEX_END__',
      ),
    });
    const { output } = await readUntil(machine, session.id, 0, '__KLEX_END__');
    const reported = [...output.matchAll(/__KLEX_CWD__(.*?)__KLEX_END__/gs)]
      .at(-1)?.[1]
      ?.trim();
    expect(reported).toBeDefined();
    await expect(realpath(reported ?? '')).resolves.toBe(
      await realpath(machine.cwd),
    );
  });

  it('passes environment overrides to the shell', async () => {
    const machine = await startMachine();
    const session = await machine.tool<ShellInfo>('createShellSession', {
      ...testShell(),
      env: { KLEX_CONFORMANCE: 'env-value' },
    });
    await machine.tool('writeShellSession', {
      id: session.id,
      data: command(
        'printf "<$KLEX_CONFORMANCE>\\n"',
        'echo ^<%KLEX_CONFORMANCE%^>',
      ),
    });
    const { output } = await readUntil(machine, session.id, 0, '<env-value>');
    expect(output).toContain('<env-value>');
  });

  it('reports exit state and removes closed sessions', async () => {
    const machine = await startMachine();
    const session = await machine.tool<ShellInfo>(
      'createShellSession',
      testShell(),
    );
    await machine.tool('writeShellSession', {
      id: session.id,
      data: command('exit 7', 'exit 7'),
    });
    const result = await readUntilExit(machine, session.id);
    expect(result).toMatchObject({ running: false, exitCode: 7 });
    const [listed] = await machine.tool<ShellInfo[]>('listShellSessions');
    expect(listed).toMatchObject({
      id: session.id,
      running: false,
      exitCode: 7,
    });
    await expect(
      machine.tool('closeShellSession', { id: session.id }),
    ).resolves.toEqual({ ok: true });
    expect(
      await machine.toolError('writeShellSession', {
        id: session.id,
        data: 'x',
      }),
    ).toContain('Unknown shell session');
    await expect(machine.tool('listShellSessions')).resolves.toEqual([]);
  });

  it('validates cursors, resize and unknown sessions', async () => {
    const machine = await startMachine();
    const session = await machine.tool<ShellInfo>(
      'createShellSession',
      testShell(),
    );
    const read = await machine.tool<ReadResult>('readShellSession', {
      id: session.id,
    });
    expect(
      await machine.toolError('readShellSession', {
        id: session.id,
        cursor: read.cursor + 1_000_000,
      }),
    ).toContain('beyond');
    await expect(
      machine.tool('resizeShellSession', {
        id: session.id,
        cols: 100,
        rows: 30,
      }),
    ).resolves.toEqual({ ok: true });
    const missing = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
    expect(
      await machine.toolError('resizeShellSession', {
        id: missing,
        cols: 80,
        rows: 20,
      }),
    ).toBe(`Error: Unknown shell session: ${missing}`);
  });

  it.skipIf(windows)(
    'reports exec failures through the session like node-pty',
    async () => {
      const machine = await startMachine();
      const session = await machine.tool<ShellInfo>('createShellSession', {
        shell: '/missing/shell',
      });
      expect(session).toMatchObject({ shell: '/missing/shell', running: true });
      const result = await readUntilExit(machine, session.id);
      expect(result).toMatchObject({ running: false, exitCode: 1, signal: 0 });
      const message = 'execvp(3) failed.: No such file or directory\r\n';
      // node-pty drops output that is still unread when its 200 ms exit drain expires.
      expect(implementation === 'ts' ? ['', message] : [message]).toContain(
        result.output,
      );
    },
  );
});
