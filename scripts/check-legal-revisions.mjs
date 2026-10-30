import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assert } from '../apps/website/src/legal/legal.ts';
import {
  createLegalSource,
  validateRegistry,
} from '../apps/website/src/legal/node/index.ts';

export const legalRoot = 'apps/website/content/legal';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function checkLegalRevisions({ baseSha, root = repositoryRoot }) {
  assert(
    typeof baseSha === 'string' &&
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseSha),
    'An explicit trusted Git SHA is required',
  );
  try {
    git(root, ['cat-file', '-e', `${baseSha}^{commit}`]);
  } catch {
    throw new Error(`Trusted legal baseline cannot be resolved: ${baseSha}`);
  }
  const sources = await createLegalSource(join(root, legalRoot)).load();
  const tree = git(root, [
    'ls-tree',
    '-r',
    '-z',
    baseSha,
    '--',
    `${legalRoot}/`,
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const blobs = new Map();
  for (const line of tree) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line);
    assert(
      match && ['100644', '100755'].includes(match[1]) && match[2] === 'blob',
      'Trusted legal baseline contains a non-regular file',
    );
    const path = match[4].slice(legalRoot.length + 1);
    // Ignore the obsolete manifest when migrating from the registration-based system.
    if (path === 'revisions.lock.json') continue;
    assert(
      path === 'policies.json' ||
        /^[a-z][a-z0-9-]*\/[1-9]\d{3}-\d{2}-\d{2}\.md$/.test(path),
      `Unexpected trusted legal path: ${path}`,
    );
    blobs.set(path, git(root, ['cat-file', 'blob', match[3]]));
  }
  if (!blobs.size) return { previous: 0, revisions: sources.revisions.length };
  assert(
    blobs.has('policies.json'),
    'Trusted baseline policy registry is missing',
  );
  const baseRegistry = validateRegistry(
    JSON.parse(blobs.get('policies.json').toString('utf8')),
  );
  assert(
    baseRegistry.policies.every(
      (type, index) => sources.registry.policies[index]?.slug === type.slug,
    ),
    'Existing policy identities cannot be removed, renamed, or reordered',
  );
  const latest = new Map();
  let previous = 0;
  for (const [path, bytes] of blobs) {
    if (path === 'policies.json') continue;
    const current = sources.revisions.find((entry) => entry.source === path);
    assert(
      current?.bytes.equals(bytes),
      `Previously pushed legal source changed, renamed, or disappeared: ${path}`,
    );
    previous++;
    if (
      !latest.has(current.policy) ||
      current.revision > latest.get(current.policy)
    )
      latest.set(current.policy, current.revision);
  }
  for (const entry of sources.revisions) {
    if (blobs.has(entry.source)) continue;
    assert(
      !latest.has(entry.policy) || entry.revision > latest.get(entry.policy),
      `New revision must be later than all existing revisions: ${entry.source}`,
    );
  }
  return { previous, revisions: sources.revisions.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    assert(
      process.argv.length === 3,
      'Usage: node scripts/check-legal-revisions.mjs <trusted-base-sha>',
    );
    const result = await checkLegalRevisions({ baseSha: process.argv[2] });
    console.log(
      `Legal history verified: ${result.previous} unchanged baseline revisions, ${result.revisions} candidate revisions.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
