import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, test } from 'node:test';

import config from '../.releaserc.js';
import {
  artifactBinary,
  hostPlatform,
  platformPackageName,
  platforms,
} from './packages.mjs';
import {
  prepare,
  stagingDirectory,
  verifyConditions,
  verifyRelease,
} from './release-plugin.mjs';

const pkgRoot = 'mcp-servers/klex-machine';
const logger = { log() {} };
let cwd;
let artifacts;
let registry;
let unpublished;

async function writeBinaries(reportedVersion) {
  for (const platform of platforms) {
    const binary = artifactBinary(artifacts, platform);
    await mkdir(join(binary, '..'), { recursive: true });
    await writeFile(
      binary,
      `#!/usr/bin/env node\nprocess.stdout.write('${reportedVersion}\\n');\n`,
    );
    await chmod(binary, 0o644);
  }
}

// Answers npm's package metadata requests for every platform package except
// those in `unpublished`.
beforeEach(async () => {
  unpublished = new Set();
  registry = createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    const known =
      platforms.some((platform) => platformPackageName(platform) === name) &&
      !unpublished.has(name);
    response.writeHead(known ? 200 : 404, {
      'content-type': 'application/json',
    });
    response.end(
      JSON.stringify(
        known
          ? {
              name,
              'dist-tags': { latest: '0.0.0' },
              versions: { '0.0.0': { name, version: '0.0.0' } },
            }
          : { error: 'Not found' },
      ),
    );
  });
  await new Promise((done) => registry.listen(0, '127.0.0.1', done));
  cwd = await mkdtemp(join(tmpdir(), 'klex-machine-release-'));
  artifacts = join(cwd, 'artifacts');
  await mkdir(join(cwd, pkgRoot), { recursive: true });
  await writeFile(
    join(cwd, pkgRoot, 'package.json'),
    JSON.stringify({
      name: '@klex/machine',
      version: '0.1.0',
      license: 'Apache-2.0',
      repository: { type: 'git', url: 'https://example.invalid/klex.git' },
      publishConfig: { access: 'public', provenance: false },
    }),
  );
});

afterEach(async () => {
  registry.close();
  await rm(cwd, { force: true, recursive: true });
});

function context(version, builtVersion = version) {
  return {
    cwd,
    env: {
      ...process.env,
      npm_config_cache: join(cwd, 'npm-cache'),
      npm_config_registry: `http://127.0.0.1:${registry.address().port}/`,
      KLEX_MACHINE_BINARIES: artifacts,
      KLEX_MACHINE_BUILT_VERSION: builtVersion,
    },
    logger,
    nextRelease: { version },
  };
}

test('publishes platform packages before @semantic-release/npm publishes the launcher', () => {
  const names = config.plugins.map((plugin) =>
    String(Array.isArray(plugin) ? plugin[0] : plugin),
  );
  const machine = names.findIndex((name) =>
    /[\\/]npm[\\/]release-plugin\.mjs$/.test(name),
  );
  assert.ok(machine > 0);
  assert.ok(machine < names.indexOf('@semantic-release/npm'));
  assert.deepEqual(config.plugins[machine][1], { pkgRoot });
});

test('requires every release binary', async () => {
  await assert.rejects(
    verifyConditions({ pkgRoot }, context('1.11.0')),
    /Missing release binaries/,
  );
  await writeBinaries('1.11.0');
  await verifyConditions({ pkgRoot }, context('1.11.0'));
});

test('requires every platform package to exist on npm', async () => {
  await writeBinaries('1.11.0');
  const name = platformPackageName(platforms[0]);
  unpublished.add(name);
  await assert.rejects(
    verifyConditions({ pkgRoot }, context('1.11.0')),
    new RegExp(`^Error: ${name} must exist on npm`),
  );
});

test('rejects binaries built for another version', async () => {
  await writeBinaries('1.11.0');
  await verifyConditions({ pkgRoot }, context('1.11.0'));
  await assert.rejects(
    verifyRelease({ pkgRoot }, context('1.11.0', '1.10.2')),
    /built as 1\.10\.2, but this release is 1\.11\.0/,
  );
});

test('rejects a host binary that reports another version', {
  skip: process.platform === 'win32' || !hostPlatform(),
}, async () => {
  await writeBinaries('1.10.2');
  await verifyConditions({ pkgRoot }, context('1.11.0'));
  await assert.rejects(
    verifyRelease({ pkgRoot }, context('1.11.0')),
    /reports version 1\.10\.2, not 1\.11\.0/,
  );
});

test('stages every platform package and pins the launcher to them', async () => {
  await writeBinaries('1.11.0');
  await prepare({ pkgRoot }, context('1.11.0'));

  const launcher = JSON.parse(
    await readFile(join(cwd, pkgRoot, 'package.json'), 'utf8'),
  );
  assert.equal(launcher.version, '1.11.0');
  assert.deepEqual(
    launcher.optionalDependencies,
    Object.fromEntries(
      platforms.map((platform) => [platformPackageName(platform), '1.11.0']),
    ),
  );

  for (const platform of platforms) {
    const directory = join(stagingDirectory(join(cwd, pkgRoot)), platform.name);
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, platformPackageName(platform));
    assert.equal(manifest.version, '1.11.0');
    assert.deepEqual(manifest.os, [platform.os]);
    assert.deepEqual(manifest.cpu, [platform.cpu]);
    assert.equal(manifest.bin, undefined);
    assert.deepEqual(manifest.publishConfig, {
      access: 'public',
      provenance: false,
    });
    const executable =
      platform.os === 'win32' ? 'klex-machine.exe' : 'klex-machine';
    assert.match(
      await readFile(join(directory, 'bin', executable), 'utf8'),
      /1\.11\.0/,
    );
  }
});
