import { parseArgs } from 'node:util';

interface Parsed {
  readonly core: readonly number[];
  readonly prerelease: readonly string[];
}

function parse(version: string): Parsed {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(
      version,
    );
  if (!match) throw new Error(`Invalid version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semver precedence, which is also how the Tauri updater orders versions. */
export function compareVersions(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(a.core[index]) - Number(b.core[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const difference = compareIdentifiers(x, y);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// Exits 0 when --candidate sorts after --current, 1 otherwise.
if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      candidate: { type: 'string' },
      current: { type: 'string' },
    },
    strict: true,
  });
  if (!values.candidate || !values.current) {
    throw new Error('--candidate and --current are required');
  }
  process.exitCode =
    compareVersions(values.candidate, values.current) > 0 ? 0 : 1;
}
