import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  createCatalog,
  createLegalSource,
} from '../apps/website/src/legal/node/index.ts';
import { checkLegalRevisions, legalRoot } from './check-legal-revisions.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const markdown = (policy, date) =>
  `---\ntitle: Synthetic ${policy} ${date}\nrequiresConsent: true\n---\n\n## Scope\n\nSynthetic fixture only.\n`;
const json = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const git = (root, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
async function commit(root) {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Legal Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  return git(root, 'rev-parse', 'HEAD');
}
const registry = {
  schemaVersion: 1,
  policies: [
    { slug: 'privacy', label: 'Privacy' },
    { slug: 'terms', label: 'Terms' },
  ],
};
async function fixture({ existing = true, manifests = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klex-legal-git-'));
  roots.push(root);
  git(root, 'init', '-q');
  await writeFile(join(root, 'README.md'), 'Synthetic Git fixture\n');
  const directory = join(root, legalRoot);
  if (manifests) {
    await mkdir(directory, { recursive: true });
    await json(join(directory, 'policies.json'), registry);
    if (existing) await add(directory, 'privacy', '2020-01-01');
  }
  return { root, directory, baseSha: await commit(root) };
}
async function add(directory, policy, date) {
  await mkdir(join(directory, policy), { recursive: true });
  await writeFile(
    join(directory, policy, `${date}.md`),
    markdown(policy, date),
  );
}

test('unchanged history and new Markdown revisions pass without registration', async () => {
  const data = await fixture();
  assert.equal((await checkLegalRevisions(data)).previous, 1);
  await add(data.directory, 'privacy', '2021-01-01');
  await add(data.directory, 'terms', '2020-01-01');
  assert.equal((await checkLegalRevisions(data)).revisions, 3);
});

test('baseline predating legal directories permits first rollout', async () => {
  const data = await fixture({ manifests: false });
  await mkdir(data.directory, { recursive: true });
  await json(join(data.directory, 'policies.json'), registry);
  await add(data.directory, 'privacy', '2020-01-01');
  assert.equal((await checkLegalRevisions(data)).previous, 0);
});

test('empty rollout passes; unresolved and unspecified baselines fail closed', async () => {
  const data = await fixture({ existing: false });
  assert.equal((await checkLegalRevisions(data)).revisions, 0);
  for (const baseSha of ['0'.repeat(40), '1'.repeat(40)])
    await assert.rejects(
      checkLegalRevisions({ ...data, baseSha }),
      /cannot be resolved/,
    );
  await assert.rejects(
    checkLegalRevisions({ ...data, baseSha: 'HEAD' }),
    /explicit trusted/,
  );
});

for (const [label, rewrite] of [
  ['body', (text) => `${text}Changed.\n`],
  ['title', (text) => text.replace('Synthetic privacy', 'Rewritten privacy')],
  [
    'consent metadata',
    (text) => text.replace('requiresConsent: true', 'requiresConsent: false'),
  ],
  ['whitespace', (text) => `${text}\n`],
]) {
  test(`editing pushed ${label} fails even though the build computes a consistent new hash`, async () => {
    const data = await fixture();
    const bytes = Buffer.from(rewrite(markdown('privacy', '2020-01-01')));
    await writeFile(join(data.directory, 'privacy/2020-01-01.md'), bytes);
    const catalog = createCatalog(
      await createLegalSource(data.directory).load(),
    );
    assert.equal(
      catalog.policies.privacy[0].sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    await assert.rejects(
      checkLegalRevisions(data),
      /source changed, renamed, or disappeared/,
    );
  });
}

test('a newly added revision becomes immutable against the next push baseline', async () => {
  const data = await fixture({ existing: false });
  await add(data.directory, 'privacy', '2020-01-01');
  await checkLegalRevisions(data);
  const previousPush = await commit(data.root);
  await writeFile(
    join(data.directory, 'privacy/2020-01-01.md'),
    `${markdown('privacy', '2020-01-01')}Edited after push.\n`,
  );
  await assert.rejects(
    checkLegalRevisions({ ...data, baseSha: previousPush }),
    /source changed/,
  );
});

test('deleting a pushed source fails', async () => {
  const data = await fixture();
  await rm(join(data.directory, 'privacy/2020-01-01.md'));
  await assert.rejects(
    checkLegalRevisions(data),
    /source changed, renamed, or disappeared/,
  );
});

test('renaming a revision fails', async () => {
  const data = await fixture();
  await rename(
    join(data.directory, 'privacy/2020-01-01.md'),
    join(data.directory, 'privacy/2021-01-01.md'),
  );
  await assert.rejects(
    checkLegalRevisions(data),
    /source changed, renamed, or disappeared/,
  );
});

test('symlink replacement fails', async () => {
  const data = await fixture();
  const path = join(data.directory, 'privacy/2020-01-01.md');
  await rm(path);
  await writeFile(
    join(data.root, 'external.md'),
    markdown('privacy', '2020-01-01'),
  );
  await symlink(join(data.root, 'external.md'), path);
  await assert.rejects(checkLegalRevisions(data), /Unexpected policy source/);
});

test('registry identities cannot be removed or reordered; new DPA can be appended', async () => {
  const data = await fixture();
  const path = join(data.directory, 'policies.json');
  const next = JSON.parse(await readFile(path, 'utf8'));
  next.policies.push({ slug: 'dpa', label: 'Synthetic DPA' });
  await json(path, next);
  await add(data.directory, 'dpa', '2020-01-01');
  assert.equal((await checkLegalRevisions(data)).revisions, 2);
  next.policies.reverse();
  await json(path, next);
  await assert.rejects(checkLegalRevisions(data), /identities cannot/);
  next.policies = next.policies.filter((entry) => entry.slug !== 'privacy');
  await json(path, next);
  await assert.rejects(checkLegalRevisions(data));
});

test('missing registry and schema downgrades fail closed', async () => {
  const data = await fixture();
  const path = join(data.directory, 'policies.json');
  await json(path, { ...registry, schemaVersion: 0 });
  await assert.rejects(checkLegalRevisions(data), /Invalid policy registry/);
  await rm(path);
  await assert.rejects(checkLegalRevisions(data));
});

test('new revisions cannot be inserted before an existing upcoming revision', async () => {
  const data = await fixture();
  await add(data.directory, 'privacy', '2099-01-01');
  data.baseSha = await commit(data.root);
  await add(data.directory, 'privacy', '2021-01-01');
  await assert.rejects(checkLegalRevisions(data), /later than all existing/);
});

test('the obsolete empty lock manifest can be removed during migration', async () => {
  const data = await fixture({ existing: false });
  const path = join(data.directory, 'revisions.lock.json');
  await json(path, { schemaVersion: 1, revisions: [] });
  data.baseSha = await commit(data.root);
  await rm(path);
  await add(data.directory, 'privacy', '2020-01-01');
  assert.equal((await checkLegalRevisions(data)).revisions, 1);
});
