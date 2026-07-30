import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCliArgs } from './cli';

describe('parseCliArgs', () => {
  const originalEnv = process.env.KLEX_DATA_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.KLEX_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.KLEX_DATA_DIR = originalEnv;
    } else {
      delete process.env.KLEX_DATA_DIR;
    }
  });

  it('defaults to process.cwd() when no args or env var provided', () => {
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBe(originalCwd);
  });

  it('uses KLEX_DATA_DIR env var when no CLI arg provided', () => {
    process.env.KLEX_DATA_DIR = '/env/data-dir';
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBe('/env/data-dir');
  });

  it('CLI arg overrides KLEX_DATA_DIR env var', () => {
    process.env.KLEX_DATA_DIR = '/env/data-dir';
    const result = parseCliArgs(['--data-dir', '/cli/data-dir']);
    expect(result.dataDirectory).toBe('/cli/data-dir');
  });

  it('supports short form -d', () => {
    const result = parseCliArgs(['-d', '/short/dir']);
    expect(result.dataDirectory).toBe('/short/dir');
  });

  it('exits with code 0 when --help is passed', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    expect(() => parseCliArgs(['--help'])).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('exits with code 0 when -h is passed', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    expect(() => parseCliArgs(['-h'])).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
