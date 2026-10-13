import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const extensionPackages = [
  'mcp-extension-client',
  'mcp-extension-push-notifications',
  'mcp-extension-realtime-media',
].map((scope) => ({
  scope,
  name: `@stagewise/${scope}`,
  packageRoot: `packages/${scope}`,
  tagFormat: `@stagewise/${scope}-v\${version}`,
}));

export async function reachableTags(cwd, tagFormat) {
  const { stdout } = await exec(
    'git',
    [
      'tag',
      '--merged',
      'HEAD',
      '--list',
      tagFormat.replace(`\${version}`, '*'),
      '--sort=-version:refname',
    ],
    { cwd },
  );
  return stdout.trim().split('\n').filter(Boolean);
}

export async function npmVersion(name, cwd) {
  const { stdout } = await exec('npm', ['view', name, 'version', '--json'], {
    cwd,
    timeout: 30_000,
  });
  const version = JSON.parse(stdout);
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected one stable npm version for ${name}`);
  }
  return version;
}

export function assertBaseline({ name, tagFormat, tags, publishedVersion }) {
  const prefix = tagFormat.replace(`\${version}`, '');
  const tag = tags.find(
    (candidate) =>
      candidate.startsWith(prefix) &&
      /^\d+\.\d+\.\d+$/.test(candidate.slice(prefix.length)),
  );
  const expected = tagFormat.replace(`\${version}`, publishedVersion);
  if (tag !== expected) {
    throw new Error(
      `${name}: npm publishes ${publishedVersion}, but the latest reachable release tag is ${tag ?? 'missing'}. ` +
        `Verify release history and establish ${expected} at a verified historical or explicitly reconstructed baseline before publishing. ` +
        'Do not move existing published tags. See NPM-RELEASES.md.',
    );
  }
  return publishedVersion;
}

export async function verifyBaseline(target, cwd, providers = {}) {
  const tags = await (providers.reachableTags ?? reachableTags)(
    cwd,
    target.tagFormat,
  );
  const publishedVersion = await (providers.npmVersion ?? npmVersion)(
    target.name,
    cwd,
  );
  return assertBaseline({ ...target, tags, publishedVersion });
}

export async function verifyExtensionBaselines(cwd) {
  for (const target of extensionPackages) await verifyBaseline(target, cwd);
}

export function resolveRuntimeDependencies(manifest, workspacePackages) {
  const resolved = structuredClone(manifest);
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, specifier] of Object.entries(resolved[field] ?? {})) {
      if (!specifier.startsWith('workspace:')) {
        if (/^(file:|link:|catalog:)/.test(specifier))
          throw new Error(`Non-registry runtime dependency: ${name}`);
        continue;
      }
      const dependency = workspacePackages.get(name);
      if (
        !dependency ||
        dependency.private ||
        !/^\d+\.\d+\.\d+$/.test(dependency.version)
      ) {
        throw new Error(
          `Unknown, private, or unversioned workspace runtime dependency: ${name}`,
        );
      }
      resolved[field][name] = dependency.version;
    }
  }
  return resolved;
}

export async function publishedHelperVersion(cwd, providers = {}) {
  const helper = extensionPackages[0];
  const tags = await (providers.reachableTags ?? reachableTags)(
    cwd,
    helper.tagFormat,
  );
  const prefix = helper.tagFormat.replace(`\${version}`, '');
  const tag = tags.find(
    (candidate) =>
      candidate.startsWith(prefix) &&
      /^\d+\.\d+\.\d+$/.test(candidate.slice(prefix.length)),
  );
  if (!tag)
    throw new Error(`${helper.name}: missing reachable published helper tag`);
  const version = tag.slice(prefix.length);
  const sleep =
    providers.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  let failure;
  for (const delay of [0, 1000, 3000]) {
    if (delay) await sleep(delay);
    try {
      const published = await (providers.npmVersion ?? npmVersion)(
        `${helper.name}@${version}`,
        cwd,
      );
      if (published !== version)
        throw new Error(`Registry returned ${published}, expected ${version}`);
      return version;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(
    `${helper.name}@${version} is not confirmed published; refusing to prepare consumers`,
    { cause: failure },
  );
}

export async function prepareManifest(manifest, cwd, providers = {}) {
  const helper = extensionPackages[0];
  const helperManifest = JSON.parse(
    await readFile(resolve(cwd, helper.packageRoot, 'package.json'), 'utf8'),
  );
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const needsHelper = fields.some((field) =>
    manifest[field]?.[helper.name]?.startsWith('workspace:'),
  );
  const version = needsHelper
    ? await publishedHelperVersion(cwd, providers)
    : helperManifest.version;
  return resolveRuntimeDependencies(
    manifest,
    new Map([[helper.name, { ...helperManifest, version }]]),
  );
}

export async function prepare({ pkgRoot }, { cwd, nextRelease }) {
  const manifestPath = resolve(cwd, pkgRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== nextRelease.version)
    throw new Error(
      'npm version preparation must run before workspace dependency resolution',
    );
  const resolved = await prepareManifest(manifest, cwd);
  await writeFile(manifestPath, `${JSON.stringify(resolved, null, 2)}\n`);
}

export async function verifyConditions({ pkgRoot, tagFormat }, { cwd }) {
  const manifest = JSON.parse(
    await readFile(resolve(cwd, pkgRoot, 'package.json'), 'utf8'),
  );
  await verifyBaseline({ name: manifest.name, tagFormat }, cwd);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv[2] !== '--preflight')
    throw new Error(
      'Usage: node scripts/mcp-extension-release-plugin.mjs --preflight',
    );
  await verifyExtensionBaselines(process.cwd());
}
