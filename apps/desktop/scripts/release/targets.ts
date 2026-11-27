export type Channel = 'stable' | 'nightly';

export interface ReleaseTarget {
  readonly id: string;
  /** Tauri updater platform key: `{os}-{arch}`. */
  readonly platform: string;
  readonly bundles: readonly Bundle[];
}

export interface Bundle {
  /** Directory under `target/release/bundle`. */
  readonly directory: string;
  /** Suffix of the file Tauri writes there. */
  readonly sourceSuffix: string;
  /** Suffix of the published file, after `klex-desktop-<version>-<target>`. */
  readonly suffix: string;
  /** Tauri updater installer name, set when this bundle carries an update. */
  readonly installer?: string;
}

const dmg: Bundle = { directory: 'dmg', sourceSuffix: '.dmg', suffix: '.dmg' };
const app: Bundle = {
  directory: 'macos',
  sourceSuffix: '.app.tar.gz',
  suffix: '.app.tar.gz',
  installer: 'app',
};
const nsis: Bundle = {
  directory: 'nsis',
  sourceSuffix: '-setup.exe',
  suffix: '-setup.exe',
  installer: 'nsis',
};
const appImage: Bundle = {
  directory: 'appimage',
  sourceSuffix: '.AppImage',
  suffix: '.AppImage',
  installer: 'appimage',
};
const deb: Bundle = {
  directory: 'deb',
  sourceSuffix: '.deb',
  suffix: '.deb',
  installer: 'deb',
};

export const TARGETS: readonly ReleaseTarget[] = [
  { id: 'darwin-arm64', platform: 'darwin-aarch64', bundles: [dmg, app] },
  { id: 'darwin-x64', platform: 'darwin-x86_64', bundles: [dmg, app] },
  { id: 'linux-arm64', platform: 'linux-aarch64', bundles: [appImage, deb] },
  { id: 'linux-x64', platform: 'linux-x86_64', bundles: [appImage, deb] },
  { id: 'windows-x64', platform: 'windows-x86_64', bundles: [nsis] },
];

/**
 * The bundle served under the bare `{os}-{arch}` key, for updaters that
 * can't tell which installer they came from.
 */
export function defaultUpdateBundle(target: ReleaseTarget): Bundle {
  const bundle = target.bundles.find((candidate) => candidate.installer);
  if (!bundle) throw new Error(`${target.id} has no updater bundle`);
  return bundle;
}

export function findTarget(id: string): ReleaseTarget {
  const target = TARGETS.find((candidate) => candidate.id === id);
  if (!target) {
    throw new Error(
      `Unknown target ${id}; expected one of ${TARGETS.map((t) => t.id).join(', ')}`,
    );
  }
  return target;
}

export function assetName(
  version: string,
  target: ReleaseTarget,
  bundle: Bundle,
): string {
  return `klex-desktop-${version}-${target.id}${bundle.suffix}`;
}

export function parseChannel(value: string): Channel {
  if (value !== 'stable' && value !== 'nightly') {
    throw new Error(`Unsupported release channel: ${value}`);
  }
  return value;
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{8}\.[1-9]\d*$/;

export function isStableVersion(version: string): boolean {
  return STABLE_VERSION.test(version);
}

export function assertReleaseVersion(channel: Channel, version: string): void {
  const valid =
    channel === 'stable'
      ? isStableVersion(version)
      : NIGHTLY_VERSION.test(version);
  if (!valid) {
    throw new Error(`Invalid ${channel} Klex Desktop version: ${version}`);
  }
}

export function releaseTag(version: string): string {
  return `desktop-v${version}`;
}

/** Rolling release whose only asset is the channel's `latest.json`. */
export function channelPointerTag(channel: Channel): string {
  return `desktop-channel-${channel}`;
}

export function manifestUrl(repository: string, channel: Channel): string {
  return `https://github.com/${repository}/releases/download/${channelPointerTag(channel)}/latest.json`;
}
