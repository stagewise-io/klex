import { z } from 'zod';

import packageJson from '../../package.json';

export const RELEASE_CHANNELS = ['stable', 'nightly'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const RELEASE_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-x64-gnu',
  'windows-x64',
] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export type ArchiveExtension = 'tar.gz' | 'zip';

export interface ReleaseTargetDefinition {
  readonly architecture: NodeJS.Architecture;
  readonly archiveExtension: ArchiveExtension;
  readonly nativePackageTarget: string;
  readonly platform: NodeJS.Platform;
  readonly target: ReleaseTarget;
}

const TARGET_DEFINITIONS: readonly ReleaseTargetDefinition[] = [
  {
    architecture: 'arm64',
    archiveExtension: 'tar.gz',
    nativePackageTarget: 'darwin-arm64',
    platform: 'darwin',
    target: 'darwin-arm64',
  },
  {
    architecture: 'x64',
    archiveExtension: 'tar.gz',
    nativePackageTarget: 'darwin-x64',
    platform: 'darwin',
    target: 'darwin-x64',
  },
  {
    architecture: 'arm64',
    archiveExtension: 'tar.gz',
    nativePackageTarget: 'linux-arm64-gnu',
    platform: 'linux',
    target: 'linux-arm64-gnu',
  },
  {
    architecture: 'x64',
    archiveExtension: 'tar.gz',
    nativePackageTarget: 'linux-x64-gnu',
    platform: 'linux',
    target: 'linux-x64-gnu',
  },
  {
    architecture: 'x64',
    archiveExtension: 'zip',
    nativePackageTarget: 'win32-x64-msvc',
    platform: 'win32',
    target: 'windows-x64',
  },
];

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const nightlyVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly(\d{8})c(\d{3})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const gitCommitPattern = /^[a-f0-9]{40}$/;

declare const __KLEX_VERSION__: string;

export function isStableVersion(version: string): boolean {
  return stableVersionPattern.test(version);
}

export function isNightlyVersion(version: string): boolean {
  const match = nightlyVersionPattern.exec(version);
  if (!match) return false;

  const dateValue = match[4];
  const counterValue = match[5];
  if (!dateValue || !counterValue || counterValue === '000') return false;

  const year = Number.parseInt(dateValue.slice(0, 4), 10);
  const month = Number.parseInt(dateValue.slice(4, 6), 10);
  const day = Number.parseInt(dateValue.slice(6, 8), 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function resolveReleaseChannel(version: string): ReleaseChannel {
  if (isStableVersion(version)) return 'stable';
  if (isNightlyVersion(version)) return 'nightly';
  throw new Error(`Invalid Klex release version: ${version}`);
}

export type ReleaseVersionOrder = -1 | 0 | 1;

function compareNumericParts(
  left: readonly bigint[],
  right: readonly bigint[],
): ReleaseVersionOrder {
  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index] ?? 0n;
    const rightPart = right[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

/** Compare two validated versions from the same release channel. */
export function compareReleaseVersions(
  left: string,
  right: string,
): ReleaseVersionOrder {
  const leftChannel = resolveReleaseChannel(left);
  const rightChannel = resolveReleaseChannel(right);
  if (leftChannel !== rightChannel) {
    throw new Error(
      `Cannot compare Klex versions from different channels: ${left} and ${right}`,
    );
  }

  const pattern =
    leftChannel === 'stable' ? stableVersionPattern : nightlyVersionPattern;
  const leftMatch = pattern.exec(left);
  const rightMatch = pattern.exec(right);
  if (!leftMatch || !rightMatch) {
    throw new Error('Validated Klex release versions could not be parsed');
  }
  const indices = leftChannel === 'stable' ? [1, 2, 3] : [1, 2, 3, 4, 5];
  return compareNumericParts(
    indices.map((index) => BigInt(leftMatch[index] ?? '0')),
    indices.map((index) => BigInt(rightMatch[index] ?? '0')),
  );
}

export function isNewerReleaseVersion(
  candidate: string,
  current: string,
): boolean {
  return compareReleaseVersions(candidate, current) > 0;
}

export function resolveApplicationVersion(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackVersion: string = packageJson.version,
): string {
  const version = environment.KLEX_VERSION?.trim() || fallbackVersion;
  const channel = resolveReleaseChannel(version);
  const requestedChannel = environment.KLEX_RELEASE_CHANNEL?.trim();
  if (
    requestedChannel !== undefined &&
    !RELEASE_CHANNELS.includes(requestedChannel as ReleaseChannel)
  ) {
    throw new Error(`Invalid Klex release channel: ${requestedChannel}`);
  }
  if (requestedChannel !== undefined && requestedChannel !== channel) {
    throw new Error(
      `Klex version ${version} belongs to the ${channel} channel, not ${requestedChannel}`,
    );
  }
  const requestedTag = environment.KLEX_RELEASE_TAG?.trim();
  const expectedTag = `v${version}`;
  if (requestedTag !== undefined && requestedTag !== expectedTag) {
    throw new Error(
      `Klex release tag ${requestedTag} does not match ${expectedTag}`,
    );
  }
  return version;
}

export const KLEX_VERSION =
  typeof __KLEX_VERSION__ === 'string'
    ? __KLEX_VERSION__
    : resolveApplicationVersion();

export function resolveReleaseTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): ReleaseTargetDefinition {
  const definition = TARGET_DEFINITIONS.find(
    (candidate) =>
      candidate.platform === platform &&
      candidate.architecture === architecture,
  );
  if (!definition) {
    throw new Error(
      `Klex release target is not supported for ${platform}-${architecture}`,
    );
  }
  return definition;
}

export function getReleaseArtifactName(
  version: string,
  target: ReleaseTarget,
): string {
  resolveReleaseChannel(version);
  const definition = TARGET_DEFINITIONS.find(
    (candidate) => candidate.target === target,
  );
  if (!definition)
    throw new Error(`Unsupported Klex release target: ${target}`);
  return `klex-${version}-${target}.${definition.archiveExtension}`;
}

export const releaseArtifactSchema = z.object({
  archiveFileName: z.string().min(1),
  archiveSha256: z.string().regex(sha256Pattern),
  archiveSize: z.number().int().positive(),
  nodeVersion: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  notarized: z.boolean(),
  signed: z.boolean(),
  signingProvider: z.string().min(1).optional(),
  target: z.enum(RELEASE_TARGETS),
  url: z.url(),
  verified: z.boolean(),
});

const releaseIdentitySchema = z.object({
  channel: z.enum(RELEASE_CHANNELS),
  gitCommit: z.string().regex(gitCommitPattern),
  schemaVersion: z.literal(1),
  version: z.string(),
});

function validateReleaseIdentity(
  release: { readonly channel: ReleaseChannel; readonly version: string },
  context: z.RefinementCtx,
): boolean {
  let expectedChannel: ReleaseChannel;
  try {
    expectedChannel = resolveReleaseChannel(release.version);
  } catch {
    context.addIssue({
      code: 'custom',
      message: `Invalid Klex release version: ${release.version}`,
      path: ['version'],
    });
    return false;
  }
  if (release.channel !== expectedChannel) {
    context.addIssue({
      code: 'custom',
      message: `Version ${release.version} belongs to the ${expectedChannel} channel`,
      path: ['channel'],
    });
  }
  return true;
}

function validateArchiveName(
  version: string,
  artifact: {
    readonly archiveFileName: string;
    readonly target: ReleaseTarget;
  },
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  const expectedName = getReleaseArtifactName(version, artifact.target);
  if (artifact.archiveFileName !== expectedName) {
    context.addIssue({
      code: 'custom',
      message: `Expected archive name ${expectedName}`,
      path: [...path, 'archiveFileName'],
    });
  }
}

export const releaseBuildMetadataSchema = releaseIdentitySchema
  .extend({
    artifact: releaseArtifactSchema.omit({ url: true }),
  })
  .superRefine((metadata, context) => {
    if (!validateReleaseIdentity(metadata, context)) return;
    validateArchiveName(metadata.version, metadata.artifact, context, [
      'artifact',
    ]);
  });

export const releaseManifestSchema = releaseIdentitySchema
  .extend({
    artifacts: z.array(releaseArtifactSchema).min(1),
  })
  .superRefine((manifest, context) => {
    if (!validateReleaseIdentity(manifest, context)) return;
    for (const [index, artifact] of manifest.artifacts.entries()) {
      validateArchiveName(manifest.version, artifact, context, [
        'artifacts',
        index,
      ]);
    }
  });

export const completeReleaseManifestSchema = releaseManifestSchema.superRefine(
  (manifest, context) => {
    const targetCounts = new Map<ReleaseTarget, number>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      targetCounts.set(
        artifact.target,
        (targetCounts.get(artifact.target) ?? 0) + 1,
      );
      validatePlatformStatus(artifact, context, index);
    }

    for (const target of RELEASE_TARGETS) {
      const count = targetCounts.get(target) ?? 0;
      if (count !== 1) {
        context.addIssue({
          code: 'custom',
          message: `Expected exactly one artifact for ${target}; found ${count}`,
          path: ['artifacts'],
        });
      }
    }
  },
);

function validatePlatformStatus(
  artifact: z.infer<typeof releaseArtifactSchema>,
  context: z.RefinementCtx,
  index: number,
): void {
  const path = ['artifacts', index] as const;
  if (artifact.target.startsWith('linux-')) {
    if (
      artifact.signed ||
      artifact.verified ||
      artifact.notarized ||
      artifact.signingProvider !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Linux artifacts must use checksum verification only',
        path: [...path],
      });
    }
    return;
  }

  if (artifact.target === 'windows-x64') {
    if (
      !artifact.signed ||
      !artifact.verified ||
      artifact.notarized ||
      artifact.signingProvider !== 'azure-trusted-signing'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Windows artifacts must be verified with Azure Trusted Signing and must not be notarized',
        path: [...path],
      });
    }
    return;
  }

  if (
    !artifact.signed ||
    !artifact.verified ||
    !artifact.notarized ||
    artifact.signingProvider !== 'apple-developer-id'
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'macOS artifacts must be verified with Apple Developer ID and notarized',
      path: [...path],
    });
  }
}

export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;
export type ReleaseBuildMetadata = z.infer<typeof releaseBuildMetadataSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
