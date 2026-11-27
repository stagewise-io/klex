import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assembleRelease } from './assemble-release.ts';
import { collectArtifacts } from './collect-artifacts.ts';
import { verifyUpdaterSignature } from './minisign.ts';
import { createNightlyVersion } from './nightly-version.ts';
import { createReleaseConfig } from './release-config.ts';
import { extractReleaseNotes } from './release-notes.ts';
import { compareVersions } from './semver.ts';
import { assetName, findTarget, TARGETS } from './targets.ts';

const REPOSITORY = 'stagewise-io/klex';

function base64Lines(...lines: string[]): string {
  return Buffer.from(`${lines.join('\n')}\n`).toString('base64');
}

/** A minisign key pair in the encoding `tauri signer` uses. */
function createSigner(keyId = Buffer.from('0123456789abcdef', 'hex')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const publicKeyFile = base64Lines(
    'untrusted comment: minisign public key',
    Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64'),
  );
  const signFile = (data: Buffer, trustedComment: string, prehash = true) => {
    const message = prehash
      ? createHash('blake2b512').update(data).digest()
      : data;
    const signature = sign(null, message, privateKey);
    const global = sign(
      null,
      Buffer.concat([signature, Buffer.from(trustedComment)]),
      privateKey,
    );
    return base64Lines(
      'untrusted comment: signature from tauri secret key',
      Buffer.concat([
        Buffer.from(prehash ? 'ED' : 'Ed'),
        keyId,
        signature,
      ]).toString('base64'),
      `trusted comment: ${trustedComment}`,
      global.toString('base64'),
    );
  };
  return { publicKeyFile, signFile };
}

describe('nightly versions', () => {
  it('counts up per day from the next patch version', () => {
    expect(
      createNightlyVersion({
        date: '20261127',
        packageVersion: '0.1.0',
        tags: [
          'desktop-v0.1.1-nightly.20261127.1',
          'desktop-v0.1.1-nightly.20261127.9',
          'desktop-v0.1.1-nightly.20261126.12',
          'v0.1.1-nightly20261127c003',
        ],
      }),
    ).toEqual({
      tag: 'desktop-v0.1.1-nightly.20261127.10',
      version: '0.1.1-nightly.20261127.10',
    });
  });

  it('rejects invalid dates and package versions', () => {
    expect(() =>
      createNightlyVersion({
        date: '20260230',
        packageVersion: '0.1.0',
        tags: [],
      }),
    ).toThrow(/Invalid nightly date/);
    expect(() =>
      createNightlyVersion({
        date: '20261127',
        packageVersion: '0.1',
        tags: [],
      }),
    ).toThrow(/Invalid stable/);
  });
});

describe('release config', () => {
  it('adds the channel updater and Windows signing', () => {
    const config = createReleaseConfig({
      channel: 'nightly',
      publicKey: 'cHVibGlj\n',
      repository: REPOSITORY,
      version: '0.1.1-nightly.20261127.1',
      windowsSignScript: 'C:\\klex\\sign-windows.ps1',
    });
    expect(config.version).toBe('0.1.1-nightly.20261127.1');
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.bundle.windows.signCommand.args).toContain(
      'C:\\klex\\sign-windows.ps1',
    );
    expect(config.plugins.updater).toMatchObject({
      pubkey: 'cHVibGlj',
      endpoints: [
        'https://github.com/stagewise-io/klex/releases/download/desktop-channel-nightly/latest.json',
      ],
      requireSignedVersion: true,
    });
  });

  it('refuses a version from the other channel', () => {
    expect(() =>
      createReleaseConfig({
        channel: 'stable',
        publicKey: 'key',
        repository: REPOSITORY,
        version: '0.1.1-nightly.20261127.1',
        windowsSignScript: 'sign.ps1',
      }),
    ).toThrow(/Invalid stable/);
  });
});

describe('updater signatures', () => {
  const data = Buffer.from('Klex Desktop update');

  it('accepts prehashed and legacy signatures and returns the comment', () => {
    const { publicKeyFile, signFile } = createSigner();
    expect(
      verifyUpdaterSignature(
        publicKeyFile,
        signFile(data, 'version:1.0.0'),
        data,
      ),
    ).toBe('version:1.0.0');
    expect(
      verifyUpdaterSignature(
        publicKeyFile,
        signFile(data, 'version:1.0.0', false),
        data,
      ),
    ).toBe('version:1.0.0');
  });

  it('rejects other files, other keys and edited comments', () => {
    const { publicKeyFile, signFile } = createSigner();
    const signature = signFile(data, 'version:1.0.0');
    expect(() =>
      verifyUpdaterSignature(publicKeyFile, signature, Buffer.from('other')),
    ).toThrow(/does not match/);
    const other = createSigner(Buffer.from('fedcba9876543210', 'hex'));
    expect(() =>
      verifyUpdaterSignature(other.publicKeyFile, signature, data),
    ).toThrow(/different key/);
    const sameId = createSigner();
    expect(() =>
      verifyUpdaterSignature(sameId.publicKeyFile, signature, data),
    ).toThrow(/does not match/);
    const lines = Buffer.from(signature, 'base64').toString().split('\n');
    lines[2] = 'trusted comment: version:9.9.9';
    expect(() =>
      verifyUpdaterSignature(
        publicKeyFile,
        Buffer.from(lines.join('\n')).toString('base64'),
        data,
      ),
    ).toThrow(/tampered/);
  });
});

describe('version order', () => {
  it('orders nightlies by date and counter, below their stable release', () => {
    const ordered = [
      '0.1.0',
      '0.1.1-nightly.20261126.2',
      '0.1.1-nightly.20261127.1',
      '0.1.1-nightly.20261127.10',
      '0.1.1',
      '0.1.2-nightly.20261128.1',
      '0.10.0',
    ];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(() => compareVersions('0.2', '0.2.0')).toThrow(/Invalid version/);
  });
});

describe('release notes', () => {
  it('extracts one version section, keeping its subsections', () => {
    const changelog =
      '# Changelog\n\n## 0.2.0\n\n- New\n\n### Fixes\n\n- Fixed\n\n## 0.1.0\n\n- Old\n';
    expect(extractReleaseNotes(changelog, '0.2.0')).toBe(
      '- New\n\n### Fixes\n\n- Fixed',
    );
    expect(() => extractReleaseNotes(changelog, '0.3.0')).toThrow(
      /no "## 0.3.0"/,
    );
  });
});

describe('collecting and assembling a release', () => {
  const version = '0.2.0';

  /** Fakes `target/release/bundle` with signed updater bundles. */
  function fakeBundles(
    root: string,
    targetId: string,
    signFile: (data: Buffer, comment: string) => string,
    signedFor = version,
  ) {
    const bundleDirectory = join(root, 'bundle', targetId);
    for (const bundle of findTarget(targetId).bundles) {
      const directory = join(bundleDirectory, bundle.directory);
      mkdirSync(directory, { recursive: true });
      const file = join(
        directory,
        `Klex Desktop_${version}${bundle.sourceSuffix}`,
      );
      const data = Buffer.from(`${targetId}${bundle.suffix}`);
      writeFileSync(file, data);
      if (bundle.installer) {
        writeFileSync(
          `${file}.sig`,
          signFile(data, `timestamp:1\tfile:${file}\tversion:${signedFor}`),
        );
      }
    }
    return bundleDirectory;
  }

  function collectAll(
    signFile: (data: Buffer, comment: string) => string,
    signedFor = version,
  ) {
    const root = mkdtempSync(join(tmpdir(), 'klex-desktop-release-'));
    const output = join(root, 'release');
    for (const target of TARGETS) {
      collectArtifacts({
        bundleDirectory: fakeBundles(root, target.id, signFile, signedFor),
        outputDirectory: output,
        target,
        version,
      });
    }
    return output;
  }

  it('writes latest.json and checksums for every target', () => {
    const { publicKeyFile, signFile } = createSigner();
    const directory = collectAll(signFile);
    const { manifest, files } = assembleRelease({
      channel: 'stable',
      directory,
      notes: 'Notes',
      publicKey: publicKeyFile,
      publishedAt: new Date('2026-11-27T10:00:00Z'),
      repository: REPOSITORY,
      version,
    });
    expect(files).toHaveLength(9);
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'linux-aarch64',
      'linux-aarch64-appimage',
      'linux-aarch64-deb',
      'linux-x86_64',
      'linux-x86_64-appimage',
      'linux-x86_64-deb',
      'windows-x86_64',
      'windows-x86_64-nsis',
    ]);
    expect(manifest.platforms['linux-x86_64']?.url).toBe(
      `https://github.com/stagewise-io/klex/releases/download/desktop-v0.2.0/${assetName(
        version,
        findTarget('linux-x64'),
        { directory: '', sourceSuffix: '', suffix: '.AppImage' },
      )}`,
    );
    const written = JSON.parse(
      readFileSync(join(directory, 'latest.json'), 'utf8'),
    );
    expect(written).toEqual(manifest);
    const checksums = readFileSync(join(directory, 'checksums.txt'), 'utf8');
    expect(checksums.trim().split('\n')).toHaveLength(9);
    expect(readdirSync(directory)).toContain('latest.json');
  });

  it('refuses signatures from another key or for another version', () => {
    const { signFile } = createSigner();
    const other = createSigner();
    const options = {
      channel: 'stable' as const,
      notes: '',
      publishedAt: new Date(),
      repository: REPOSITORY,
      version,
    };
    expect(() =>
      assembleRelease({
        ...options,
        directory: collectAll(signFile),
        publicKey: other.publicKeyFile,
      }),
    ).toThrow(/does not match/);
    const signer = createSigner();
    expect(() =>
      assembleRelease({
        ...options,
        directory: collectAll(signer.signFile, '0.1.9'),
        publicKey: signer.publicKeyFile,
      }),
    ).toThrow(/signed for version 0.1.9/);
  });

  it('refuses a release with a missing target or stray files', () => {
    const { publicKeyFile, signFile } = createSigner();
    const options = {
      channel: 'stable' as const,
      notes: '',
      publicKey: publicKeyFile,
      publishedAt: new Date(),
      repository: REPOSITORY,
      version,
    };
    const stray = collectAll(signFile);
    writeFileSync(join(stray, 'extra.zip'), 'x');
    expect(() => assembleRelease({ ...options, directory: stray })).toThrow(
      /Unexpected release files: extra.zip/,
    );
    const root = mkdtempSync(join(tmpdir(), 'klex-desktop-release-'));
    const target = findTarget('darwin-arm64');
    collectArtifacts({
      bundleDirectory: fakeBundles(root, target.id, signFile),
      outputDirectory: join(root, 'release'),
      target,
      version,
    });
    expect(() =>
      assembleRelease({ ...options, directory: join(root, 'release') }),
    ).toThrow(/Missing build output for darwin-x64/);
  });
});
