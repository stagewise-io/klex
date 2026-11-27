import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { isStableVersion, releaseTag } from './targets.ts';

export interface NightlyVersionOptions {
  readonly counter?: number;
  readonly date: string;
  readonly packageVersion: string;
  readonly tags: readonly string[];
}

export interface NightlyVersion {
  readonly tag: string;
  readonly version: string;
}

/**
 * `<next patch>-nightly.<YYYYMMDD>.<n>`: numeric prerelease identifiers, so
 * semver (and the Tauri updater) orders nightlies by date, then counter,
 * and below the stable release they lead up to.
 */
export function createNightlyVersion(
  options: NightlyVersionOptions,
): NightlyVersion {
  if (!isStableVersion(options.packageVersion)) {
    throw new Error(
      `Invalid stable Klex Desktop package version: ${options.packageVersion}`,
    );
  }
  validateDate(options.date);
  const [major, minor, patch] = options.packageVersion.split('.').map(Number);
  const prefix = `${major}.${minor}.${Number(patch) + 1}-nightly.${options.date}.`;
  const tagPrefix = releaseTag(prefix);
  const highest = options.tags.reduce((maximum, tag) => {
    if (!tag.startsWith(tagPrefix)) return maximum;
    const counter = tag.slice(tagPrefix.length);
    return /^[1-9]\d*$/.test(counter)
      ? Math.max(maximum, Number(counter))
      : maximum;
  }, 0);
  const counter = options.counter ?? highest + 1;
  if (!Number.isInteger(counter) || counter < 1) {
    throw new Error('Nightly counter must be a positive integer');
  }
  const version = `${prefix}${counter}`;
  return { tag: releaseTag(version), version };
}

export function formatNightlyDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function validateDate(value: string): void {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  const date = match
    ? new Date(
        Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
      )
    : undefined;
  if (!date || formatNightlyDate(date) !== value) {
    throw new Error(`Invalid nightly date: ${value}; expected YYYYMMDD`);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      counter: { type: 'string' },
      date: { type: 'string' },
    },
    strict: true,
  });
  if (values.counter && !/^\d+$/.test(values.counter)) {
    throw new Error(`Invalid nightly counter: ${values.counter}`);
  }
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const tags = execFileSync('git', ['tag', '--list', 'desktop-v*-nightly.*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const result = createNightlyVersion({
    ...(values.counter ? { counter: Number(values.counter) } : {}),
    date: values.date ?? formatNightlyDate(new Date()),
    packageVersion: packageJson.version,
    tags,
  });
  process.stdout.write(`version=${result.version}\ntag=${result.tag}\n`);
}
