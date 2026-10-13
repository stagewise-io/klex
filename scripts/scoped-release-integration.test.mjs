import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import semanticRelease from 'semantic-release';

import { createScopedReleaseConfig } from './scoped-release-config.mjs';

const exec = promisify(execFile);
const releaseEnvironmentNames = [
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
];
const silentLogger = {
  error() {},
  log() {},
  success() {},
};

function createReleaseEnvironment(environment = process.env) {
  return Object.fromEntries(
    releaseEnvironmentNames.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

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
    const releaseEnvironment = createReleaseEnvironment();
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
        env: releaseEnvironment,
        logger: silentLogger,
      },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test('sequential release commands preserve the installed workspace after manifest preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sequential-release-'));
  const workflow = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  const setting = workflow.match(
    /^\s+((?:PNPM_CONFIG|npm_config)_VERIFY_DEPS_BEFORE_RUN): "false"$/im,
  );
  assert.ok(setting, 'Missing release dependency verification setting');
  const { packageManager } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const environment = { ...createReleaseEnvironment(), CI: 'true' };
  const releaseEnvironment = { ...environment, [setting[1]]: 'false' };
  const pnpm = (args, env = environment) =>
    exec('pnpm', args, {
      cwd: root,
      env,
      timeout: 30_000,
      shell: process.platform === 'win32',
    });

  try {
    await mkdir(join(root, 'packages', 'helper'), { recursive: true });
    await mkdir(join(root, 'packages', 'consumer'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager,
        scripts: { 'release-check': 'pnpm exec node -p 42' },
      }),
    );
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\nverifyDepsBeforeRun: install\n',
    );
    const helper = { name: '@fixture/helper', version: '0.1.0' };
    const consumer = {
      name: '@fixture/consumer',
      version: '0.1.0',
      dependencies: { [helper.name]: 'workspace:*' },
    };
    await writeFile(
      join(root, 'packages', 'helper', 'package.json'),
      JSON.stringify(helper),
    );
    const consumerPath = join(root, 'packages', 'consumer', 'package.json');
    await writeFile(consumerPath, JSON.stringify(consumer));
    assert.equal(
      (await pnpm(['--version'])).stdout.trim(),
      packageManager.slice('pnpm@'.length),
    );
    await pnpm(['install', '--offline', '--ignore-scripts']);
    await pnpm([
      'install',
      '--offline',
      '--ignore-scripts',
      '--frozen-lockfile',
    ]);
    const lockfilePath = join(root, 'pnpm-lock.yaml');
    const helperLinkPath = join(
      root,
      'packages',
      'consumer',
      'node_modules',
      '@fixture',
      'helper',
    );
    const lockfile = await readFile(lockfilePath, 'utf8');
    const helperLink = await readlink(helperLinkPath);

    const prepared = {
      ...consumer,
      version: '0.2.0',
      dependencies: { [helper.name]: '0.1.1' },
    };
    const preparedJson = JSON.stringify(prepared);
    await writeFile(consumerPath, preparedJson);
    await assert.rejects(
      pnpm(['exec', 'node', '-p', '42'], {
        ...environment,
        npm_config_verify_deps_before_run: 'false',
      }),
      (error) => {
        assert.match(error.stdout + error.stderr, /ERR_PNPM_OUTDATED_LOCKFILE/);
        return true;
      },
    );

    for (const args of [
      ['exec', 'node', '-p', '42'],
      ['run', 'release-check'],
    ]) {
      const { stdout } = await pnpm(args, releaseEnvironment);
      assert.match(stdout, /42/);
      assert.equal(await readFile(lockfilePath, 'utf8'), lockfile);
      assert.equal(await readlink(helperLinkPath), helperLink);
      assert.equal(await readFile(consumerPath, 'utf8'), preparedJson);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release fixture only receives allowlisted environment variables', () => {
  assert.deepEqual(
    createReleaseEnvironment({
      CI: 'true',
      GITHUB_TOKEN: 'secret',
      HOME: '/home/release-test',
      PATH: '/usr/bin',
    }),
    {
      HOME: '/home/release-test',
      PATH: '/usr/bin',
    },
  );
});

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

for (const scope of [
  'mcp-extension-client',
  'mcp-extension-push-notifications',
  'mcp-extension-realtime-media',
]) {
  test(`dry-runs independent ${scope} versions`, async () => {
    const baseline =
      scope === 'mcp-extension-push-notifications' ? '0.1.1' : '0.1.0';
    const result = await dryRunFixture({
      baseline,
      commits: [
        `fix(${scope}): repair release packaging`,
        'feat(machine): unrelated feature',
      ],
      packageRoot: `packages/${scope}`,
      scope,
      tagFormat: `@stagewise/${scope}-v\${version}`,
    });
    assert.equal(
      result.nextRelease.version,
      baseline === '0.1.1' ? '0.1.2' : '0.1.1',
    );
    const unrelated = await dryRunFixture({
      baseline,
      commits: ['fix(machine): unrelated fix'],
      packageRoot: `packages/${scope}`,
      scope,
      tagFormat: `@stagewise/${scope}-v\${version}`,
    });
    assert.equal(unrelated, false);
  });
}
