import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PackagedAppArtifact } from '@stagewise/app-packager';

import { buildReleaseArtifact } from './build-artifact';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function createPackagedDistribution(
  root: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): PackagedAppArtifact {
  const directory = join(root, 'package');
  const executable = join(
    directory,
    platform === 'win32' ? 'klex.exe' : 'klex',
  );
  mkdirSync(join(directory, 'node_modules', 'native'), { recursive: true });
  writeFileSync(executable, 'main');
  writeFileSync(join(directory, 'javascript-sandbox-worker.js'), 'worker');
  writeFileSync(join(directory, 'livekit-rtc.node'), 'livekit');
  writeFileSync(
    join(directory, 'node_modules', 'native', 'addon.node'),
    'addon',
  );
  return {
    architecture,
    assets: ['javascript-sandbox-worker.js'],
    nodeVersion: '22.21.1',
    outputPath: executable,
    platform,
    sha256: 'f'.repeat(64),
    signing: {
      notarized: false,
      provider: 'none',
      signed: false,
      verified: false,
    },
  };
}

describe('release artifact builder', () => {
  it('stages, smokes, archives, hashes, and describes a Linux build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'klex-release-build-'));
    const packaged = createPackagedDistribution(root, 'linux', 'x64');
    const smoke = vi.fn();
    try {
      const result = await buildReleaseArtifact(
        {
          channel: 'stable',
          gitCommit: COMMIT,
          outputDirectory: join(root, 'output'),
          tag: 'v1.2.3',
          version: '1.2.3',
        },
        {
          archive: (_directory, archivePath) =>
            writeFileSync(archivePath, 'deterministic archive'),
          packageAgent: async () => packaged,
          resolveTarget: () => ({
            architecture: 'x64',
            archiveExtension: 'tar.gz',
            nativePackageTarget: 'linux-x64-gnu',
            platform: 'linux',
            target: 'linux-x64-gnu',
          }),
          smoke,
        },
      );

      expect(smoke).toHaveBeenCalledOnce();
      expect(result.metadata).toMatchObject({
        artifact: {
          archiveFileName: 'klex-1.2.3-linux-x64-gnu.tar.gz',
          archiveSize: 21,
          nodeVersion: '22.21.1',
          notarized: false,
          signed: false,
          target: 'linux-x64-gnu',
          verified: false,
        },
        channel: 'stable',
        gitCommit: COMMIT,
        schemaVersion: 1,
        version: '1.2.3',
      });
      expect(result.metadata.artifact.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('signs the complete macOS payload before notarization and archiving', async () => {
    const root = mkdtempSync(join(tmpdir(), 'klex-release-build-'));
    const packaged = createPackagedDistribution(root, 'darwin', 'arm64');
    const events: string[] = [];
    let signedFiles: readonly string[] = [];
    try {
      const result = await buildReleaseArtifact(
        {
          channel: 'nightly',
          gitCommit: COMMIT,
          outputDirectory: join(root, 'output'),
          tag: 'v1.0.1-nightly20260902c001',
          version: '1.0.1-nightly20260902c001',
        },
        {
          archive: (_directory, archivePath) => {
            events.push('archive');
            writeFileSync(archivePath, 'archive');
          },
          isMachO: () => true,
          notarize: async () => {
            events.push('notarize');
            return 'submission-id';
          },
          packageAgent: async () => packaged,
          resolveTarget: () => ({
            architecture: 'arm64',
            archiveExtension: 'tar.gz',
            nativePackageTarget: 'darwin-arm64',
            platform: 'darwin',
            target: 'darwin-arm64',
          }),
          run: () => '',
          signMany: async ({ files }) => {
            events.push('sign');
            signedFiles = files;
            return {
              provider: 'apple-developer-id',
              signed: true,
              verified: true,
            };
          },
          smoke: () => events.push('smoke'),
        },
      );

      expect(events).toEqual(['sign', 'notarize', 'smoke', 'archive']);
      expect(signedFiles).toContainEqual(
        expect.stringMatching(/\/livekit-rtc\.node$/),
      );
      expect(signedFiles.at(-1)).toMatch(/\/klex$/);
      expect(result.metadata.artifact).toMatchObject({
        notarized: true,
        signed: true,
        signingProvider: 'apple-developer-id',
        target: 'darwin-arm64',
        verified: true,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('emits a signed Windows ZIP artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'klex-release-build-'));
    const packaged = createPackagedDistribution(root, 'win32', 'x64');
    try {
      const result = await buildReleaseArtifact(
        {
          channel: 'stable',
          gitCommit: COMMIT,
          outputDirectory: join(root, 'output'),
          tag: 'v2.0.0',
          version: '2.0.0',
        },
        {
          archive: (_directory, archivePath) =>
            writeFileSync(archivePath, 'zip'),
          packageAgent: async () => packaged,
          resolveTarget: () => ({
            architecture: 'x64',
            archiveExtension: 'zip',
            nativePackageTarget: 'win32-x64-msvc',
            platform: 'win32',
            target: 'windows-x64',
          }),
          signMany: async () => ({
            provider: 'azure-trusted-signing',
            signed: true,
            verified: true,
          }),
          smoke: () => undefined,
        },
      );

      expect(result.metadata.artifact).toMatchObject({
        archiveFileName: 'klex-2.0.0-windows-x64.zip',
        notarized: false,
        signed: true,
        signingProvider: 'azure-trusted-signing',
        target: 'windows-x64',
        verified: true,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('rejects a channel/version mismatch before packaging', async () => {
    const packageAgent = vi.fn();
    await expect(
      buildReleaseArtifact(
        {
          channel: 'stable',
          gitCommit: COMMIT,
          outputDirectory: 'unused',
          tag: 'v1.2.3',
          version: '1.0.1-nightly20260902c001',
        },
        { packageAgent },
      ),
    ).rejects.toThrow(
      'Klex version 1.0.1-nightly20260902c001 belongs to the nightly channel, not stable',
    );
    expect(packageAgent).not.toHaveBeenCalled();
  });
});
