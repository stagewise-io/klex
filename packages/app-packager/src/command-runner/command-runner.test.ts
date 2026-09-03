import { describe, expect, it, vi } from 'vitest';

import {
  CommandExecutionError,
  createCommandRunner,
} from './command-runner.js';

describe('createCommandRunner', () => {
  it('preserves diagnostics while redacting sensitive arguments', () => {
    const runner = createCommandRunner({
      spawn: (() => ({
        status: 1,
        signal: null,
        stdout: 'stdout detail',
        stderr: 'stderr detail',
        pid: 1,
        output: [],
      })) as never,
    });

    expect(() =>
      runner.run('tool', ['--password', 'top-secret'], {
        sensitiveArgumentIndexes: [1],
      }),
    ).toThrow(CommandExecutionError);
    try {
      runner.run('tool', ['--password', 'top-secret'], {
        sensitiveArgumentIndexes: [1],
      });
    } catch (error) {
      expect(String(error)).not.toContain('top-secret');
      expect(error).toMatchObject({
        command: 'tool --password <redacted>',
        stdout: 'stdout detail',
        stderr: 'stderr detail',
      });
    }
  });

  it('passes timeouts to child processes and reports expiration', () => {
    const spawn = vi.fn(() => ({
      error: Object.assign(new Error('spawnSync tool ETIMEDOUT'), {
        code: 'ETIMEDOUT',
      }),
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
    }));
    const runner = createCommandRunner({ spawn: spawn as never });

    expect(() =>
      runner.run('tool', ['sign', 'app.exe'], { timeoutMs: 300_000 }),
    ).toThrow('Command timed out after 300000ms: tool sign app.exe');
    expect(spawn).toHaveBeenCalledWith(
      'tool',
      ['sign', 'app.exe'],
      expect.objectContaining({ timeout: 300_000 }),
    );
  });
});
