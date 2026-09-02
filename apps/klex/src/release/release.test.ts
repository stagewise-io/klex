import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json';
import {
  completeReleaseManifestSchema,
  getReleaseArtifactName,
  isNightlyVersion,
  isStableVersion,
  releaseManifestSchema,
  resolveApplicationVersion,
  resolveReleaseChannel,
  resolveReleaseTarget,
} from './release';

const targetCases = [
  ['darwin', 'arm64', 'darwin-arm64', 'tar.gz'],
  ['darwin', 'x64', 'darwin-x64', 'tar.gz'],
  ['linux', 'arm64', 'linux-arm64-gnu', 'tar.gz'],
  ['linux', 'x64', 'linux-x64-gnu', 'tar.gz'],
  ['win32', 'x64', 'windows-x64', 'zip'],
] as const;

function validManifest() {
  return {
    artifacts: [
      {
        archiveFileName: 'klex-1.2.3-linux-x64-gnu.tar.gz',
        archiveSha256: 'a'.repeat(64),
        archiveSize: 42,
        nodeVersion: '26.1.0',
        notarized: false,
        signed: true,
        target: 'linux-x64-gnu',
        url: 'https://github.com/stagewise/klex-agent/releases/download/v1.2.3/klex-1.2.3-linux-x64-gnu.tar.gz',
        verified: true,
      },
    ],
    channel: 'stable',
    gitCommit: 'b'.repeat(40),
    schemaVersion: 1,
    version: '1.2.3',
  };
}

function validCompleteManifest() {
  const manifest = validManifest();
  const baseArtifact = getFirstArtifact(manifest);
  const artifacts = [
    ...(['darwin-arm64', 'darwin-x64'] as const).map((target) => ({
      ...baseArtifact,
      archiveFileName: `klex-1.2.3-${target}.tar.gz`,
      notarized: true,
      signed: true,
      signingProvider: 'apple-developer-id',
      target,
      url: `https://github.com/stagewise/klex-agent/releases/download/v1.2.3/klex-1.2.3-${target}.tar.gz`,
      verified: true,
    })),
    ...(['linux-arm64-gnu', 'linux-x64-gnu'] as const).map((target) => ({
      ...baseArtifact,
      archiveFileName: `klex-1.2.3-${target}.tar.gz`,
      notarized: false,
      signed: false,
      signingProvider: undefined,
      target,
      url: `https://github.com/stagewise/klex-agent/releases/download/v1.2.3/klex-1.2.3-${target}.tar.gz`,
      verified: false,
    })),
    {
      ...baseArtifact,
      archiveFileName: 'klex-1.2.3-windows-x64.zip',
      notarized: false,
      signed: true,
      signingProvider: 'azure-trusted-signing',
      target: 'windows-x64',
      url: 'https://github.com/stagewise/klex-agent/releases/download/v1.2.3/klex-1.2.3-windows-x64.zip',
      verified: true,
    },
  ];
  return { ...manifest, artifacts };
}

function getFirstArtifact(manifest: ReturnType<typeof validManifest>) {
  const artifact = manifest.artifacts[0];
  if (!artifact) throw new Error('Expected a release artifact fixture');
  return artifact;
}

describe('release target contract', () => {
  it.each(targetCases)(
    'resolves %s-%s to %s',
    (platform, architecture, target, archiveExtension) => {
      expect(
        resolveReleaseTarget(
          platform as NodeJS.Platform,
          architecture as NodeJS.Architecture,
        ),
      ).toMatchObject({ target, archiveExtension });
    },
  );

  it.each([
    ['win32', 'arm64'],
    ['linux', 'ppc64'],
    ['aix', 'x64'],
  ])('rejects unsupported host %s-%s', (platform, architecture) => {
    expect(() =>
      resolveReleaseTarget(
        platform as NodeJS.Platform,
        architecture as NodeJS.Architecture,
      ),
    ).toThrow(
      `Klex release target is not supported for ${platform}-${architecture}`,
    );
  });

  it.each([
    ['1.2.3', 'linux-x64-gnu', 'klex-1.2.3-linux-x64-gnu.tar.gz'],
    ['1.2.3', 'windows-x64', 'klex-1.2.3-windows-x64.zip'],
    [
      '1.2.4-nightly20260902c001',
      'darwin-arm64',
      'klex-1.2.4-nightly20260902c001-darwin-arm64.tar.gz',
    ],
  ] as const)('names %s %s deterministically', (version, target, expected) => {
    expect(getReleaseArtifactName(version, target)).toBe(expected);
  });
});

describe('release versions', () => {
  it.each(['0.0.0', '1.2.3', '12.34.56'])(
    'accepts stable version %s',
    (version) => {
      expect(isStableVersion(version)).toBe(true);
      expect(resolveReleaseChannel(version)).toBe('stable');
    },
  );

  it.each(['1.2.4-nightly20260902c001', '12.34.57-nightly20261231c999'])(
    'accepts nightly version %s',
    (version) => {
      expect(isNightlyVersion(version)).toBe(true);
      expect(resolveReleaseChannel(version)).toBe('nightly');
    },
  );

  it.each([
    'v1.2.3',
    '01.2.3',
    '1.2.3-beta.1',
    '1.2.4-nightly20260230c001',
    '1.2.4-nightly20260902c000',
  ])('rejects invalid release version %s', (version) => {
    expect(() => resolveReleaseChannel(version)).toThrow(
      'Invalid Klex release version',
    );
  });

  it('uses the package version as the local-build fallback', () => {
    expect(resolveApplicationVersion({})).toBe(packageJson.version);
  });

  it('uses an explicit build version override', () => {
    expect(
      resolveApplicationVersion({
        KLEX_VERSION: '1.0.1-nightly20260902c001',
        KLEX_RELEASE_CHANNEL: 'nightly',
      }),
    ).toBe('1.0.1-nightly20260902c001');
  });

  it('rejects mismatched build channels', () => {
    expect(() =>
      resolveApplicationVersion({
        KLEX_VERSION: '1.2.3',
        KLEX_RELEASE_CHANNEL: 'nightly',
      }),
    ).toThrow('belongs to the stable channel, not nightly');
  });

  it('rejects a release tag that does not match the stable version', () => {
    expect(() =>
      resolveApplicationVersion({
        KLEX_VERSION: '1.2.3',
        KLEX_RELEASE_CHANNEL: 'stable',
        KLEX_RELEASE_TAG: 'v1.2.2',
      }),
    ).toThrow('release tag v1.2.2 does not match v1.2.3');
  });

  it('accepts the mutable nightly release tag', () => {
    expect(
      resolveApplicationVersion({
        KLEX_RELEASE_CHANNEL: 'nightly',
        KLEX_RELEASE_TAG: 'nightly',
        KLEX_VERSION: '1.2.4-nightly20260902c001',
      }),
    ).toBe('1.2.4-nightly20260902c001');
  });
});

describe('release manifest schema', () => {
  it('accepts valid immutable release metadata', () => {
    expect(releaseManifestSchema.parse(validManifest())).toEqual(
      validManifest(),
    );
  });

  it.each([
    [
      'hash',
      (manifest: ReturnType<typeof validManifest>) => {
        getFirstArtifact(manifest).archiveSha256 = 'not-a-hash';
      },
    ],
    [
      'target',
      (manifest: ReturnType<typeof validManifest>) => {
        getFirstArtifact(manifest).target = 'windows-arm64';
      },
    ],
    [
      'channel',
      (manifest: ReturnType<typeof validManifest>) => {
        manifest.channel = 'preview';
      },
    ],
  ])('rejects a malformed %s', (_name, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(releaseManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a channel that does not match the version', () => {
    const manifest = validManifest();
    manifest.channel = 'nightly';
    expect(releaseManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a non-canonical archive filename', () => {
    const manifest = validManifest();
    getFirstArtifact(manifest).archiveFileName = 'klex-latest.tar.gz';
    expect(releaseManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('accepts exactly one policy-compliant artifact per target', () => {
    expect(
      completeReleaseManifestSchema.safeParse(validCompleteManifest()).success,
    ).toBe(true);
  });

  it('rejects missing and duplicate targets', () => {
    const manifest = validCompleteManifest();
    const firstArtifact = manifest.artifacts[0];
    if (!firstArtifact) throw new Error('Expected a complete manifest fixture');
    manifest.artifacts[1] = { ...firstArtifact };
    expect(completeReleaseManifestSchema.safeParse(manifest).success).toBe(
      false,
    );
  });

  it('rejects platform-inappropriate signing status', () => {
    const manifest = validCompleteManifest();
    const linuxArtifact = manifest.artifacts.find((artifact) =>
      artifact.target.startsWith('linux-'),
    );
    if (!linuxArtifact) throw new Error('Expected Linux fixture');
    linuxArtifact.signed = true;
    linuxArtifact.verified = true;
    expect(completeReleaseManifestSchema.safeParse(manifest).success).toBe(
      false,
    );
  });
});
