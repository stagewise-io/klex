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
    delete process.env.KLEX_TELEMETRY_ENDPOINT;
    delete process.env.KLEX_TELEMETRY_DEBUG;
    delete process.env.KLEX_DISABLE_TELEMETRY;
    delete process.env.KLEX_CLOUD_ENROLLMENT_TOKEN;
    delete process.env.KLEX_DANGEROUS_LOCAL_ADMIN_API_PORT;
    delete process.env.KLEX_ALLOW_UNSECURE_CLOUD;
    delete process.env.KLEX_HEADLESS;
    delete process.env.KLEX_NO_ANALYTICS;
    delete process.env.DO_NOT_TRACK;
    delete process.env.KLEX_DEPLOYMENT;
  });

  afterEach(() => {
    for (const key of [
      'KLEX_HOME',
      'KLEX_DATA_DIR',
      'KLEX_NO_CLOUD',
      'KLEX_CLOUD_BASE_URL',
      'KLEX_TELEMETRY_ENDPOINT',
      'KLEX_TELEMETRY_DEBUG',
      'KLEX_DISABLE_TELEMETRY',
      'KLEX_CLOUD_ENROLLMENT_TOKEN',
      'KLEX_DANGEROUS_LOCAL_ADMIN_API_PORT',
      'KLEX_ALLOW_UNSECURE_CLOUD',
      'KLEX_HEADLESS',
      'KLEX_NO_ANALYTICS',
      'DO_NOT_TRACK',
      'KLEX_DEPLOYMENT',
    ]) {
      if (key in originalEnv) {
        // biome-ignore lint/suspicious/noExplicitAny: restore env
        (process.env as any)[key] = originalEnv[key];
      } else {
        delete process.env[key as keyof typeof process.env];
      }
    }
  });

  describe('analytics', () => {
    it('is enabled by default', () => {
      expect(parseCliArgs([]).analyticsEnabled).toBe(true);
    });

    it('is disabled by --no-analytics', () => {
      expect(parseCliArgs(['--no-analytics']).analyticsEnabled).toBe(false);
    });

    it('is disabled by KLEX_NO_ANALYTICS=1', () => {
      process.env.KLEX_NO_ANALYTICS = '1';
      expect(parseCliArgs([]).analyticsEnabled).toBe(false);
    });

    it('is disabled by DO_NOT_TRACK=1', () => {
      process.env.DO_NOT_TRACK = '1';
      expect(parseCliArgs([]).analyticsEnabled).toBe(false);
    });

    it('ignores env values other than 1', () => {
      process.env.KLEX_NO_ANALYTICS = '0';
      process.env.DO_NOT_TRACK = '0';
      expect(parseCliArgs([]).analyticsEnabled).toBe(true);
    });

    it('lets --analytics override the env opt-out', () => {
      process.env.KLEX_NO_ANALYTICS = '1';
      process.env.DO_NOT_TRACK = '1';
      expect(parseCliArgs(['--analytics']).analyticsEnabled).toBe(true);
    });

    it('keeps --no-analytics off regardless of env', () => {
      process.env.KLEX_NO_ANALYTICS = '0';
      expect(parseCliArgs(['--no-analytics']).analyticsEnabled).toBe(false);
    });
  });

  it('leaves the data directory unset for interactive discovery', () => {
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBeUndefined();
    expect(result.agentRoot).toBe(join(homedir(), '.klex', 'agents'));
  });

  it('nests the agent directory under KLEX_HOME', () => {
    process.env.KLEX_HOME = '/custom/klex-home';
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBeUndefined();
    expect(result.agentRoot).toBe('/custom/klex-home/agents');
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
    expect(result.dataDirectory).toBeUndefined();
    cwdSpy.mockRestore();
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])(
    'treats %s KLEX_HOME as unset instead of producing a relative path',
    (_label, value) => {
      // A stray `KLEX_HOME=` in a shell profile must not relocate the agent to
      // the current working directory.
      process.env.KLEX_HOME = value;
      const result = parseCliArgs([]);
      expect(result.dataDirectory).toBeUndefined();
    },
  );

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('treats %s KLEX_DATA_DIR as unset', (_label, value) => {
    process.env.KLEX_HOME = '/custom/klex-home';
    process.env.KLEX_DATA_DIR = value;
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBeUndefined();
  });

  it('treats a blank --data-dir as unset', () => {
    process.env.KLEX_DATA_DIR = '/env/data-dir';
    const result = parseCliArgs(['--data-dir', '  ']);
    expect(result.dataDirectory).toBe('/env/data-dir');
  });

  it('trims surrounding whitespace off resolved paths', () => {
    process.env.KLEX_DATA_DIR = '  /env/data-dir  ';
    const result = parseCliArgs([]);
    expect(result.dataDirectory).toBe('/env/data-dir');
  });

  it('leaves every blank source unset for interactive discovery', () => {
    // The concrete failure mode the guard exists for: join('', ...) yields the
    // relative 'agents/default'.
    process.env.KLEX_HOME = '';
    process.env.KLEX_DATA_DIR = '';
    const result = parseCliArgs(['--data-dir', '']);
    expect(result.dataDirectory).toBeUndefined();
  });

  it('disables telemetry by default with no endpoint', () => {
    expect(parseCliArgs([])).toMatchObject({
      telemetryEndpoint: undefined,
      telemetryLevel: 'no',
    });
  });

  it('enables advanced telemetry when an endpoint is supplied', () => {
    process.env.KLEX_TELEMETRY_ENDPOINT = 'https://env.example/';
    expect(parseCliArgs([])).toMatchObject({
      telemetryEndpoint: 'https://env.example',
      telemetryLevel: 'advanced',
    });
    expect(
      parseCliArgs(['--telemetry-endpoint', 'https://cli.example/'])
        .telemetryEndpoint,
    ).toBe('https://cli.example');
  });

  it('enables debug telemetry only with an explicit opt-in', () => {
    const endpoint = ['--telemetry-endpoint', 'https://cli.example'];
    expect(parseCliArgs([...endpoint, '--telemetry-debug'])).toMatchObject({
      telemetryLevel: 'debug',
    });
    process.env.KLEX_TELEMETRY_DEBUG = '1';
    expect(parseCliArgs(endpoint).telemetryLevel).toBe('debug');
    expect(
      parseCliArgs([...endpoint, '--no-telemetry-debug']).telemetryLevel,
    ).toBe('advanced');
  });

  it('rejects debug telemetry without an endpoint', () => {
    expect(() => parseCliArgs(['--telemetry-debug'])).toThrow(
      'Debug telemetry requires an endpoint',
    );
  });

  it('lets disable-telemetry override an endpoint', () => {
    process.env.KLEX_TELEMETRY_ENDPOINT = 'https://env.example';
    process.env.KLEX_TELEMETRY_DEBUG = '1';
    process.env.KLEX_DISABLE_TELEMETRY = '1';
    expect(parseCliArgs([])).toMatchObject({
      telemetryEndpoint: undefined,
      telemetryLevel: 'no',
    });
    delete process.env.KLEX_DISABLE_TELEMETRY;
    expect(parseCliArgs(['--disable-telemetry']).telemetryLevel).toBe('no');
  });

  it('allows HTTP only for loopback telemetry endpoints', () => {
    expect(
      parseCliArgs(['--telemetry-endpoint', 'http://localhost:4318']),
    ).toMatchObject({ telemetryEndpoint: 'http://localhost:4318' });
    expect(() =>
      parseCliArgs(['--telemetry-endpoint', 'http://telemetry.example.com']),
    ).toThrow('Telemetry endpoint must use HTTPS');
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

  describe('deployment', () => {
    it('defaults to self_hosted', () => {
      expect(parseCliArgs([]).deployment).toBe('self_hosted');
    });

    it('reads KLEX_DEPLOYMENT without a CLI arg', () => {
      process.env.KLEX_DEPLOYMENT = 'cloud';
      expect(parseCliArgs([]).deployment).toBe('cloud');
    });

    it('--deployment overrides KLEX_DEPLOYMENT', () => {
      process.env.KLEX_DEPLOYMENT = 'cloud';
      expect(parseCliArgs(['--deployment', 'self_hosted']).deployment).toBe(
        'self_hosted',
      );
    });

    it('a blank --deployment still overrides KLEX_DEPLOYMENT', () => {
      process.env.KLEX_DEPLOYMENT = 'cloud';
      expect(parseCliArgs(['--deployment=']).deployment).toBe('self_hosted');
    });

    it('maps unknown CLI values to other', () => {
      expect(parseCliArgs(['--deployment', 'acme']).deployment).toBe('other');
    });
  });

  describe('headless', () => {
    it('--no-headless overrides KLEX_HEADLESS=1', () => {
      process.env.KLEX_HEADLESS = '1';
      expect(parseCliArgs(['--no-headless']).headless).toBe(false);
    });

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

  describe('dangerous local Admin API port', () => {
    it('defaults to undefined', () => {
      const result = parseCliArgs([]);
      expect(result.dangerousLocalAdminApiPort).toBeUndefined();
    });

    it('uses --dangerous-local-admin-api-port when provided', () => {
      const result = parseCliArgs(['--dangerous-local-admin-api-port', '2706']);
      expect(result.dangerousLocalAdminApiPort).toBe(2706);
    });

    it('uses KLEX_DANGEROUS_LOCAL_ADMIN_API_PORT when provided', () => {
      process.env.KLEX_DANGEROUS_LOCAL_ADMIN_API_PORT = '2707';
      const result = parseCliArgs([]);
      expect(result.dangerousLocalAdminApiPort).toBe(2707);
    });

    it('prefers the CLI option over the environment variable', () => {
      process.env.KLEX_DANGEROUS_LOCAL_ADMIN_API_PORT = '2707';
      const result = parseCliArgs(['--dangerous-local-admin-api-port', '2708']);
      expect(result.dangerousLocalAdminApiPort).toBe(2708);
    });

    it.each(['0', '65536', '12.5', 'not-a-port'])(
      'rejects invalid port %s',
      (port) => {
        expect(() =>
          parseCliArgs(['--dangerous-local-admin-api-port', port]),
        ).toThrow(`Invalid local Admin API port: ${port}`);
      },
    );
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
