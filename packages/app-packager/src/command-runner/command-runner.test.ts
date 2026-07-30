import { describe, expect, it } from 'vitest';

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
});
