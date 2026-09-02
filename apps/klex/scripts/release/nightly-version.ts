import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { isStableVersion } from '@/release';

import packageJson from '../../package.json';

const COUNTER_MAXIMUM = 999;

export interface NightlyVersionOptions {
  readonly counter?: number;
  readonly date: string;
  readonly packageVersion: string;
  readonly tags: readonly string[];
}

export interface NightlyVersionResult {
  readonly tag: string;
  readonly version: string;
}

export function createNightlyVersion(
  options: NightlyVersionOptions,
): NightlyVersionResult {
  if (!isStableVersion(options.packageVersion)) {
    throw new Error(
      `Invalid stable Klex package version: ${options.packageVersion}`,
    );
  }
  validateDate(options.date);

  const [major, minor, patch] = options.packageVersion.split('.').map(Number);
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(
      `Invalid stable Klex package version: ${options.packageVersion}`,
    );
  }
  const baseVersion = `${major}.${minor}.${patch + 1}`;
  const prefix = `v${baseVersion}-nightly${options.date}c`;
  const discoveredCounter = options.tags.reduce((maximum, tag) => {
    const match = new RegExp(`^${escapeRegExp(prefix)}(\\d{3})$`).exec(tag);
    return match?.[1]
      ? Math.max(maximum, Number.parseInt(match[1], 10))
      : maximum;
  }, 0);
  const counter = options.counter ?? discoveredCounter + 1;
  if (!Number.isInteger(counter) || counter < 1 || counter > COUNTER_MAXIMUM) {
    throw new Error(
      `Nightly counter must be an integer between 1 and ${COUNTER_MAXIMUM}`,
    );
  }

  const version = `${baseVersion}-nightly${options.date}c${String(counter).padStart(3, '0')}`;
  return { tag: `v${version}`, version };
}

export function formatNightlyDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function validateDate(value: string): void {
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`Invalid nightly date: ${value}; expected YYYYMMDD`);
  }
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(4, 6), 10);
  const day = Number.parseInt(value.slice(6, 8), 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid nightly date: ${value}; expected YYYYMMDD`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTags(): readonly string[] {
  return execFileSync('git', ['tag', '--list', 'v*-nightly*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv
      .slice(2)
      .filter((argument, index) => index > 0 || argument !== '--'),
    options: {
      counter: { type: 'string' },
      date: { type: 'string' },
      'github-output': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.counter && !/^\d+$/.test(values.counter)) {
    throw new Error(`Invalid nightly counter: ${values.counter}`);
  }
  const result = createNightlyVersion({
    ...(values.counter ? { counter: Number.parseInt(values.counter, 10) } : {}),
    date: values.date ?? formatNightlyDate(new Date()),
    packageVersion: packageJson.version,
    tags: readTags(),
  });
  if (values['github-output']) {
    process.stdout.write(`version=${result.version}\ntag=${result.tag}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
