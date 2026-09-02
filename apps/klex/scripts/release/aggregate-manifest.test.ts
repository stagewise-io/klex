import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getReleaseArtifactName,
  RELEASE_TARGETS,
  type ReleaseTarget,
} from '@/release';

import { aggregateReleaseManifest } from './aggregate-manifest';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '1.2.3';

function createInputs(directory: string): void {
  mkdirSync(directory, { recursive: true });
  for (const target of RELEASE_TARGETS) {
    const archiveFileName = getReleaseArtifactName(VERSION, target);
    const contents = Buffer.from(`archive:${target}`);
    writeFileSync(join(directory, archiveFileName), contents);
    const isMac = target.startsWith('darwin-');
    const isWindows = target.startsWith('windows-');
    writeFileSync(
      join(directory, `build-metadata-${target}.json`),
      `${JSON.stringify({
        artifact: {
          archiveFileName,
          archiveSha256: createHash('sha256').update(contents).digest('hex'),
          archiveSize: contents.length,
          nodeVersion: '22.21.1',
          notarized: isMac,
          signed: isMac || isWindows,
          ...(isMac
            ? { signingProvider: 'apple-developer-id' }
            : isWindows
              ? { signingProvider: 'azure-trusted-signing' }
              : {}),
          target,
          verified: isMac || isWindows,
        },
        channel: 'stable',
        gitCommit: COMMIT,
        schemaVersion: 1,
        version: VERSION,
      })}\n`,
    );
  }
}

function metadataPath(directory: string, target: ReleaseTarget): string {
  return join(directory, `build-metadata-${target}.json`);
}

describe('release metadata aggregation', () => {
  it('validates all archives and emits one complete manifest and checksum file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'klex-release-aggregate-'));
    try {
      createInputs(directory);
      const result = await aggregateReleaseManifest({
        channel: 'stable',
        gitCommit: COMMIT,
        inputDirectory: directory,
        repository: 'stagewise/klex-agent',
        tag: 'v1.2.3+build',
        version: VERSION,
      });

      expect(result.manifest.artifacts).toHaveLength(RELEASE_TARGETS.length);
      expect(result.manifest.artifacts[0]?.url).toContain(
        '/releases/download/v1.2.3%2Bbuild/',
      );
      const checksums = readFileSync(result.checksumsPath, 'utf8')
        .trim()
        .split('\n');
      expect(checksums).toHaveLength(RELEASE_TARGETS.length + 1);
      expect(checksums.at(-1)).toContain('  release-manifest.json');
      expect(readFileSync(result.manifestChecksumPath, 'utf8')).toBe(
        `${checksums.at(-1)}\n`,
      );
      const archiveNames = checksums.slice(0, -1).map((line) => line.slice(66));
      expect(archiveNames).toEqual([...archiveNames].sort());
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('rejects missing targets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'klex-release-aggregate-'));
    try {
      createInputs(directory);
      unlinkSync(metadataPath(directory, 'windows-x64'));
      await expect(
        aggregateReleaseManifest({
          channel: 'stable',
          gitCommit: COMMIT,
          inputDirectory: directory,
          repository: 'stagewise/klex-agent',
          tag: 'v1.2.3',
          version: VERSION,
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('rejects duplicate and malformed metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'klex-release-aggregate-'));
    try {
      createInputs(directory);
      copyFileSync(
        metadataPath(directory, 'darwin-arm64'),
        join(directory, 'build-metadata-duplicate.json'),
      );
      await expect(
        aggregateReleaseManifest({
          channel: 'stable',
          gitCommit: COMMIT,
          inputDirectory: directory,
          repository: 'stagewise/klex-agent',
          tag: 'v1.2.3',
          version: VERSION,
        }),
      ).rejects.toThrow();

      unlinkSync(join(directory, 'build-metadata-duplicate.json'));
      writeFileSync(metadataPath(directory, 'darwin-arm64'), '{invalid');
      await expect(
        aggregateReleaseManifest({
          channel: 'stable',
          gitCommit: COMMIT,
          inputDirectory: directory,
          repository: 'stagewise/klex-agent',
          tag: 'v1.2.3',
          version: VERSION,
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('rejects identity and archive checksum mismatches', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'klex-release-aggregate-'));
    try {
      createInputs(directory);
      const target = 'linux-x64-gnu';
      const path = metadataPath(directory, target);
      const metadata = JSON.parse(readFileSync(path, 'utf8'));
      metadata.gitCommit = 'f'.repeat(40);
      writeFileSync(path, JSON.stringify(metadata));
      await expect(
        aggregateReleaseManifest({
          channel: 'stable',
          gitCommit: COMMIT,
          inputDirectory: directory,
          repository: 'stagewise/klex-agent',
          tag: 'v1.2.3',
          version: VERSION,
        }),
      ).rejects.toThrow('Release identity mismatch');

      metadata.gitCommit = COMMIT;
      writeFileSync(path, JSON.stringify(metadata));
      writeFileSync(
        join(directory, getReleaseArtifactName(VERSION, target)),
        'corrupted archive',
      );
      await expect(
        aggregateReleaseManifest({
          channel: 'stable',
          gitCommit: COMMIT,
          inputDirectory: directory,
          repository: 'stagewise/klex-agent',
          tag: 'v1.2.3',
          version: VERSION,
        }),
      ).rejects.toThrow(/Archive (size|checksum) mismatch/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
