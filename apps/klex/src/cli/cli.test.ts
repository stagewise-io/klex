import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KLEX_VERSION } from '@/release';

import { parseCliArgs } from './cli';

describe('parseCliArgs', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.KLEX_HOME;
    delete process.env.KLEX_DATA_DIR;
    delete process.env.KLEX_NO_CLOUD;
    delete process.env.KLEX_CLOUD_BASE_URL;
    delete process.env.KLEX_CLOUD_ENROLLMENT_TOKEN;
    delete process.env.KLEX_ADMIN_PORT;
    delete process.env.KLEX_ALLOW_UNSECURE_CLOUD;
    delete process.env.KLEX_HEADLESS;
  });

  afterEach(() => {
    for (const key of [
      'KLEX_HOME',
      'KLEX_DATA_DIR',
      'KLEX_NO_CLOUD',
      'KLEX_CLOUD_BASE_URL',
      'KLEX_CLOUD_ENROLLMENT_TOKEN',
      'KLEX_ADMIN_PORT',
      'KLEX_ALLOW_UNSECURE_CLOUD',
      'KLEX_HEADLESS',
    ]) {
      if (key in originalEnv) {
        // biome-ignore lint/suspicious/noExplicitAny: restore env
        (process.env as any)[key] = originalEnv[key];
      } else {
        delete process.env[key as keyof typeof process.env];
      }
    }
  });

  it('defaults to ~/.klex/agents/default when no args or env vars provided', () => {
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBe(
      join(homedir(), '.klex', 'agents', 'default'),
    );
  });

  it('nests the agent directory under KLEX_HOME', () => {
    process.env.KLEX_HOME = '/custom/klex-home';
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBe(
      join('/custom/klex-home', 'agents', 'default'),
    );
  });

  it('KLEX_DATA_DIR overrides KLEX_HOME', () => {
    process.env.KLEX_HOME = '/custom/klex-home';
    process.env.KLEX_DATA_DIR = '/env/data-dir';
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBe('/env/data-dir');
  });

  it('--data-dir overrides both KLEX_DATA_DIR and KLEX_HOME', () => {
    process.env.KLEX_HOME = '/custom/klex-home';
    process.env.KLEX_DATA_DIR = '/env/data-dir';
    const result = parseCliArgs(['--data-dir', '/cli/data-dir']);
    expect(result.dataDirectory).toBe('/cli/data-dir');
  });

  it('never resolves the data directory relative to the current directory', () => {
    // Regression guard: a PATH-installed klex must resolve the same agent from
    // any working directory.
    const cwdSpy = vi
      .spyOn(process, 'cwd')
      .mockReturnValue('/some/unrelated/cwd');
    const result = parseCliArgs([]);
    expect(result.dataDirectory).not.toContain('/some/unrelated/cwd');
    cwdSpy.mockRestore();
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

  describe('--version', () => {
    it('writes the bare version to stdout and exits 0', () => {
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      expect(() => parseCliArgs(['--version'])).toThrow('process.exit called');
      expect(writeSpy).toHaveBeenCalledWith(`${KLEX_VERSION}\n`);
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
      writeSpy.mockRestore();
    });
  });

  describe('verifyNative', () => {
    it('defaults to false when the flag is absent', () => {
      const result = parseCliArgs([]);
      expect(result.verifyNative).toBe(false);
    });

    it('enables the probe when --verify-native is passed', () => {
      const result = parseCliArgs(['--verify-native']);
      expect(result.verifyNative).toBe(true);
    });
  });

  describe('headless', () => {
    it('defaults to false when no args or env var provided', () => {
      const result = parseCliArgs([]);
      expect(result.headless).toBe(false);
    });

    it('enables headless when --headless is passed', () => {
      const result = parseCliArgs(['--headless']);
      expect(result.headless).toBe(true);
    });

    it('enables headless when -H is passed', () => {
      const result = parseCliArgs(['-H']);
      expect(result.headless).toBe(true);
    });

    it('enables headless when KLEX_HEADLESS=1 and no CLI arg', () => {
      process.env.KLEX_HEADLESS = '1';
      const result = parseCliArgs([]);
      expect(result.headless).toBe(true);
    });

    it('does not enable headless when KLEX_HEADLESS is not 1', () => {
      process.env.KLEX_HEADLESS = '0';
      const result = parseCliArgs([]);
      expect(result.headless).toBe(false);
    });
  });

  describe('cloud enabled', () => {
    it('defaults to true when no args or env var provided', () => {
      const result = parseCliArgs([]);
      expect(result.cloudEnabled).toBe(true);
    });

    it('disables cloud when --no-cloud is passed', () => {
      const result = parseCliArgs(['--no-cloud']);
      expect(result.cloudEnabled).toBe(false);
    });

    it('enables cloud when --cloud is passed', () => {
      const result = parseCliArgs(['--cloud']);
      expect(result.cloudEnabled).toBe(true);
    });

    it('disables cloud when KLEX_NO_CLOUD=1 and no CLI arg', () => {
      process.env.KLEX_NO_CLOUD = '1';
      const result = parseCliArgs([]);
      expect(result.cloudEnabled).toBe(false);
    });

    it('--cloud overrides KLEX_NO_CLOUD=1 (CLI arg takes priority)', () => {
      process.env.KLEX_NO_CLOUD = '1';
      const result = parseCliArgs(['--cloud']);
      expect(result.cloudEnabled).toBe(true);
    });

    it('--no-cloud overrides KLEX_NO_CLOUD not set (CLI arg takes priority)', () => {
      const result = parseCliArgs(['--no-cloud']);
      expect(result.cloudEnabled).toBe(false);
    });
  });

  describe('cloud base url', () => {
    it('defaults to https://cloud.klex.bot', () => {
      const result = parseCliArgs([]);
      expect(result.cloudBaseUrl).toBe('https://cloud.klex.bot');
    });

    it('uses --cloud-base-url when provided', () => {
      const result = parseCliArgs([
        '--cloud-base-url',
        'https://staging.klex.bot',
      ]);
      expect(result.cloudBaseUrl).toBe('https://staging.klex.bot');
    });

    it('uses KLEX_CLOUD_BASE_URL env var when no CLI arg', () => {
      process.env.KLEX_CLOUD_BASE_URL = 'https://env.klex.bot';
      const result = parseCliArgs([]);
      expect(result.cloudBaseUrl).toBe('https://env.klex.bot');
    });

    it('CLI arg overrides KLEX_CLOUD_BASE_URL env var', () => {
      process.env.KLEX_CLOUD_BASE_URL = 'https://env.klex.bot';
      const result = parseCliArgs(['--cloud-base-url', 'https://cli.klex.bot']);
      expect(result.cloudBaseUrl).toBe('https://cli.klex.bot');
    });
  });

  describe('cloud enroll token', () => {
    it('defaults to undefined', () => {
      const result = parseCliArgs([]);
      expect(result.cloudEnrollToken).toBeUndefined();
    });

    it('uses --cloud-enroll-token when provided', () => {
      const result = parseCliArgs(['--cloud-enroll-token', 'ABCD-EFGH']);
      expect(result.cloudEnrollToken).toBe('ABCD-EFGH');
    });

    it('uses KLEX_CLOUD_ENROLLMENT_TOKEN env var when no CLI arg', () => {
      process.env.KLEX_CLOUD_ENROLLMENT_TOKEN = 'EFGH-IJKL';
      const result = parseCliArgs([]);
      expect(result.cloudEnrollToken).toBe('EFGH-IJKL');
    });

    it('CLI arg overrides KLEX_CLOUD_ENROLLMENT_TOKEN env var', () => {
      process.env.KLEX_CLOUD_ENROLLMENT_TOKEN = 'EFGH-IJKL';
      const result = parseCliArgs(['--cloud-enroll-token', 'ABCD-EFGH']);
      expect(result.cloudEnrollToken).toBe('ABCD-EFGH');
    });
  });

  describe('allow dangerous unsecure cloud', () => {
    it('defaults to false when no args or env var provided', () => {
      const result = parseCliArgs([]);
      expect(result.allowDangerousUnsecureCloud).toBe(false);
    });

    it('enables when --allow-dangerous-unsecure-cloud is passed', () => {
      const result = parseCliArgs(['--allow-dangerous-unsecure-cloud']);
      expect(result.allowDangerousUnsecureCloud).toBe(true);
    });

    it('enables when KLEX_ALLOW_UNSECURE_CLOUD=1 and no CLI arg', () => {
      process.env.KLEX_ALLOW_UNSECURE_CLOUD = '1';
      const result = parseCliArgs([]);
      expect(result.allowDangerousUnsecureCloud).toBe(true);
    });

    it('--no-allow-dangerous-unsecure-cloud overrides KLEX_ALLOW_UNSECURE_CLOUD=1', () => {
      process.env.KLEX_ALLOW_UNSECURE_CLOUD = '1';
      const result = parseCliArgs(['--no-allow-dangerous-unsecure-cloud']);
      expect(result.allowDangerousUnsecureCloud).toBe(false);
    });

    it('--allow-dangerous-unsecure-cloud overrides KLEX_ALLOW_UNSECURE_CLOUD not set', () => {
      const result = parseCliArgs(['--allow-dangerous-unsecure-cloud']);
      expect(result.allowDangerousUnsecureCloud).toBe(true);
    });
  });

  describe('verbose', () => {
    it('defaults to false when no args provided', () => {
      const result = parseCliArgs([]);
      expect(result.verbose).toBe(false);
    });

    it('enables when --verbose is passed', () => {
      const result = parseCliArgs(['--verbose']);
      expect(result.verbose).toBe(true);
    });

    it('enables when -v is passed', () => {
      const result = parseCliArgs(['-v']);
      expect(result.verbose).toBe(true);
    });

    it('disables when --no-verbose is passed', () => {
      const result = parseCliArgs(['--no-verbose']);
      expect(result.verbose).toBe(false);
    });
  });
});
