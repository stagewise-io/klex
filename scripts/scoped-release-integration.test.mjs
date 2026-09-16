import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import semanticRelease from 'semantic-release';

import { createScopedReleaseConfig } from './scoped-release-config.mjs';

const exec = promisify(execFile);
const silentLogger = {
  error() {},
  log() {},
  success() {},
};

async function git(cwd, ...args) {
  await exec('git', args, { cwd });
}

async function commit(cwd, message, content) {
  await writeFile(join(cwd, 'fixture.txt'), content);
  await git(cwd, 'add', 'fixture.txt');
  await git(cwd, 'commit', '-m', message);
}

async function dryRunFixture({
  baseline,
  commits,
  packageRoot,
  scope,
  tagFormat,
}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'scoped-release-'));
  const repository = join(temporaryRoot, 'repository');
  const remote = join(temporaryRoot, 'remote.git');

  try {
    await exec('git', ['init', '--bare', remote]);
    await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await exec('git', ['init', repository]);
    await git(repository, 'config', 'user.name', 'Release Test');
    await git(repository, 'config', 'user.email', 'release-test@example.com');
    await git(repository, 'branch', '-M', 'main');
    await git(
      repository,
      'remote',
      'add',
      'origin',
      pathToFileURL(remote).href,
    );
    await commit(repository, 'chore: baseline', 'baseline');
    await git(repository, 'tag', tagFormat.replace(`\${version}`, baseline));
    for (const [index, message] of commits.entries()) {
      await commit(repository, message, `commit-${index}`);
    }
    await git(repository, 'push', '--set-upstream', 'origin', 'main', '--tags');

    const config = createScopedReleaseConfig({ packageRoot, scope, tagFormat });
    return await semanticRelease(
      {
        ...config,
        plugins: [config.plugins[0]],
        repositoryUrl: pathToFileURL(remote).href,
      },
      {
        ci: false,
        cwd: repository,
        dryRun: true,
        logger: silentLogger,
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test('dry-runs independent scoped releases from baseline tags', async () => {
  const sdk = await dryRunFixture({
    baseline: '0.2.0',
    commits: [
      'fix(machine): unrelated machine fix',
      'fix(mcp-proxy-sdk): repair proxy transport',
    ],
    packageRoot: 'packages/mcp-proxy-sdk',
    scope: 'mcp-proxy-sdk',
    tagFormat: `@klex/mcp-proxy-sdk-v\${version}`,
  });
  assert.equal(sdk.nextRelease.version, '0.2.1');
  assert.equal(sdk.nextRelease.gitTag, '@klex/mcp-proxy-sdk-v0.2.1');

  const machine = await dryRunFixture({
    baseline: '0.1.0',
    commits: [
      'fix(mcp-proxy-sdk): unrelated SDK fix',
      'feat(machine): add enrollment command',
    ],
    packageRoot: 'mcp-servers/klex-machine',
    scope: 'machine',
    tagFormat: `@klex/machine-v\${version}`,
  });
  assert.equal(machine.nextRelease.version, '0.2.0');
  assert.equal(machine.nextRelease.gitTag, '@klex/machine-v0.2.0');
});

test('dry-run produces no release for unrelated history', async () => {
  const result = await dryRunFixture({
    baseline: '0.5.2',
    commits: ['fix(machine): unrelated machine fix'],
    packageRoot: 'packages/agent-admin-api',
    scope: 'agent-admin-api',
    tagFormat: `@klex/agent-admin-api-v\${version}`,
  });
  assert.equal(result, false);
});
