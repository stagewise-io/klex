import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineLogger } from '../src/logger.js';

afterEach(() => vi.restoreAllMocks());

describe('machine logger', () => {
  it('keeps structured errors, circular fields, and bigint safe on stderr', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const logger = createMachineLogger('info');
    const fields: Record<string, unknown> = {
      error: new Error('disk failed'),
      count: 10n,
      token: 'must-be-masked',
    };
    fields.self = fields;
    expect(() => logger.error(fields, 'Persistence failed')).not.toThrow();
    expect(stderr).toHaveBeenCalled();
    const line = String(stderr.mock.calls.at(-1)?.[0]);
    expect(line).toContain('disk failed');
    expect(line).toContain('10');
    expect(line).not.toContain('must-be-masked');
    expect(stdout).not.toHaveBeenCalled();
  });
  it('filters lower log levels and isolates failing sinks', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = createMachineLogger('warn');
    logger.info({}, 'filtered');
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockImplementation(() => {
      throw new Error('closed stderr');
    });
    expect(() =>
      logger.error({ error: new Error('original') }, 'Failure'),
    ).not.toThrow();
  });
});
