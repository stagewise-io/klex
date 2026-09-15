import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { enrollMachine } from '../src/cloud/enrollment.js';
import {
  generateMachineIdentity,
  loadMachineIdentity,
  saveMachineIdentity,
} from '../src/cloud/identity.js';
import {
  ENROLLMENT_FILE,
  IDENTITY_FILE,
  loadMachineEnrollment,
} from '../src/cloud/state.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-machine-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe('machine identity storage', () => {
  it('stores an importable private key and refuses replacement', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, IDENTITY_FILE);
    const identity = await generateMachineIdentity();
    await saveMachineIdentity(path, identity);
    await expect(loadMachineIdentity(path)).resolves.toBeDefined();
    await expect(saveMachineIdentity(path, identity)).rejects.toThrow(
      'Refusing',
    );
    if (process.platform !== 'win32') {
      const mode = (await import('node:fs/promises'))
        .stat(path)
        .then((s) => s.mode & 0o777);
      await expect(mode).resolves.toBe(0o600);
    }
  });

  it('rejects a corrupt private key', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, IDENTITY_FILE);
    await mkdir(join(directory, 'identity'));
    await writeFile(path, 'invalid');
    await expect(loadMachineIdentity(path)).rejects.toThrow('corrupt');
  });
});

describe('machine enrollment', () => {
  it('persists validated metadata without the enrollment code', async () => {
    const directory = await temporaryDirectory();
    const enrollment = await enrollMachine({
      cloudBaseUrl: 'https://cloud.example',
      code: 'one-time-secret',
      dataDir: directory,
      fetch: async () =>
        Response.json({
          machineId: 'machine-1',
          clientId: 'oauth-client-1',
          tokenEndpoint: 'https://cloud.example/api/auth/oauth2/token',
          proxyConnectionResource: 'https://cloud.example/machine-connections',
          proxyConnectionUrl: 'wss://cloud.example/machine-connections',
          mcpResourceUrl: 'https://cloud.example/machines/machine-1/mcp',
          oauthProtectedResourceUrl:
            'https://cloud.example/machines/machine-1/mcp/oauth-protected-resource',
        }),
    });
    expect(await loadMachineEnrollment(directory)).toEqual(enrollment);
    expect(
      await readFile(join(directory, ENROLLMENT_FILE), 'utf8'),
    ).not.toContain('one-time-secret');
  });

  it('keeps the private key but no metadata after failed enrollment', async () => {
    const directory = await temporaryDirectory();
    await expect(
      enrollMachine({
        cloudBaseUrl: 'https://cloud.example',
        code: 'secret',
        dataDir: directory,
        fetch: async () => new Response(null, { status: 401 }),
      }),
    ).rejects.toThrow('HTTP 401');
    await expect(
      access(join(directory, IDENTITY_FILE)),
    ).resolves.toBeUndefined();
    await expect(access(join(directory, ENROLLMENT_FILE))).rejects.toThrow();
  });

  it('rejects corrupt or incomplete enrollment metadata', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, ENROLLMENT_FILE);
    await mkdir(join(directory, 'identity'));
    await writeFile(path, '{"version":1}');
    await chmod(path, 0o600);
    await expect(loadMachineEnrollment(directory)).rejects.toThrow('corrupt');
  });
});
