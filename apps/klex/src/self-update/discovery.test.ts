import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverManagedInstallation } from './discovery';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(platform: NodeJS.Platform = 'linux') {
  const base = await mkdtemp(join(tmpdir(), 'klex-managed-'));
  directories.push(base);
  const root = join(base, 'install');
  const executableName = platform === 'win32' ? 'klex.exe' : 'klex';
  const versionDirectory = join(root, 'versions', '1.2.3');
  await mkdir(versionDirectory, { recursive: true });
  const executablePath = join(versionDirectory, executableName);
  await writeFile(executablePath, 'fixture');
  await symlink(versionDirectory, join(root, 'current'), 'dir');
  await mkdir(join(root, 'bin'));
  const receipt = {
    archiveSha256: 'a'.repeat(64),
    binDir: join(root, 'bin'),
    channel: 'stable',
    installDir: root,
    installedAt: '2026-09-05T00:00:00Z',
    manifestUrl: 'https://example.com/manifest.json',
    modifiedPathFiles: [],
    schemaVersion: 1,
    target: platform === 'win32' ? 'windows-x64' : 'linux-x64-gnu',
    version: '1.2.3',
  };
  await writeFile(join(root, 'install-receipt.json'), JSON.stringify(receipt));
  return { executablePath, platform, receipt, root };
}

async function discover(value: Awaited<ReturnType<typeof fixture>>) {
  return discoverManagedInstallation({
    executablePath: value.executablePath,
    platform: value.platform,
    target: value.platform === 'win32' ? 'windows-x64' : 'linux-x64-gnu',
    version: '1.2.3',
  });
}

describe('installer-managed installation discovery', () => {
  it.each(['linux', 'win32'] as const)(
    'accepts a canonical %s layout',
    async (platform) => {
      expect(await discover(await fixture(platform))).toMatchObject({
        version: '1.2.3',
      });
    },
  );

  it('accepts a PowerShell 5.1 receipt with a UTF-8 BOM', async () => {
    const value = await fixture('win32');
    await writeFile(
      join(value.root, 'install-receipt.json'),
      `\uFEFF${JSON.stringify(value.receipt)}`,
    );
    expect(await discover(value)).toMatchObject({ version: '1.2.3' });
  });

  it('rejects development and manually extracted executables', async () => {
    const value = await fixture();
    expect(
      await discoverManagedInstallation({
        executablePath: join(value.root, 'current', 'klex'),
        platform: 'linux',
        target: 'linux-x64-gnu',
        version: '9.9.9',
      }),
    ).toBeNull();
  });

  it.each([
    [
      'stale receipt channel',
      (receipt: Record<string, unknown>) => {
        receipt.channel = 'nightly';
      },
    ],
    [
      'wrong target',
      (receipt: Record<string, unknown>) => {
        receipt.target = 'darwin-x64';
      },
    ],
    [
      'moved root',
      (receipt: Record<string, unknown>) => {
        receipt.installDir = '/not/the/install/root';
      },
    ],
    [
      'malformed receipt',
      (receipt: Record<string, unknown>) => {
        receipt.schemaVersion = 2;
      },
    ],
  ])('rejects %s', async (_name, mutate) => {
    const value = await fixture();
    mutate(value.receipt);
    await writeFile(
      join(value.root, 'install-receipt.json'),
      JSON.stringify(value.receipt),
    );
    expect(await discover(value)).toBeNull();
  });

  it('rejects current pointing to a different executable', async () => {
    const value = await fixture();
    await rm(join(value.root, 'current'));
    await mkdir(join(value.root, 'versions', '1.2.4'));
    await writeFile(join(value.root, 'versions', '1.2.4', 'klex'), 'other');
    await symlink(
      join(value.root, 'versions', '1.2.4'),
      join(value.root, 'current'),
      'dir',
    );
    expect(await discover(value)).toBeNull();
  });
});
