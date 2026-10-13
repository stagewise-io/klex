import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  extensionPackages,
  resolveRuntimeDependencies,
} from './mcp-extension-release-plugin.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'mcp-extension-consumer-'));
const manifests = await Promise.all(
  extensionPackages.map(async (target) =>
    JSON.parse(
      await readFile(join(root, target.packageRoot, 'package.json'), 'utf8'),
    ),
  ),
);
const workspacePackages = new Map(
  manifests.map((manifest) => [manifest.name, manifest]),
);
const env = Object.fromEntries(
  [
    'PATH',
    'SYSTEMROOT',
    'PATHEXT',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
  ].flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ),
);
Object.assign(env, {
  HOME: temporary,
  USERPROFILE: temporary,
  NPM_CONFIG_USERCONFIG: join(temporary, 'npmrc'),
  NPM_CONFIG_GLOBALCONFIG: join(temporary, 'global-npmrc'),
});

async function run(command, args, cwd) {
  try {
    return await exec(command, args, {
      cwd,
      env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
      { cause: error },
    );
  }
}

try {
  await writeFile(env.NPM_CONFIG_USERCONFIG, '');
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const tarballs = [];
  for (const [index, target] of extensionPackages.entries()) {
    const source = join(root, target.packageRoot);
    const stage = join(temporary, target.scope);
    await mkdir(stage);
    const manifest = resolveRuntimeDependencies(
      manifests[index],
      workspacePackages,
    );
    for (const file of manifest.files)
      await cp(join(source, file), join(stage, file), { recursive: true });
    await writeFile(
      join(stage, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const { stdout } = await run(
      'npm',
      ['pack', '--ignore-scripts', '--json'],
      stage,
    );
    const [packed] = JSON.parse(stdout);
    const paths = packed.files.map(({ path }) => path);
    for (const file of [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
    ])
      assert.ok(paths.includes(file), `${target.name}: missing ${file}`);
    if (index > 0)
      for (const file of [
        'schema.json',
        'dist/client/index.js',
        'dist/server/index.js',
        'dist/client/index.d.ts',
        'dist/server/index.d.ts',
      ])
        assert.ok(paths.includes(file), `${target.name}: missing ${file}`);
    assert.ok(
      !paths.some((path) =>
        /(^src\/|(^|\/)(node_modules|scripts)\/|\.(test|spec)\.[cm]?[jt]sx?$)/.test(
          path,
        ),
      ),
      `${target.name}: packed development files`,
    );
    tarballs.push(join(stage, packed.filename));
  }
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'mcp-extension-consumer-check',
      private: true,
      type: 'module',
    }),
  );
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      ...tarballs,
      `@types/node@${manifests[0].devDependencies['@types/node']}`,
    ],
    consumer,
  );
  const helper = manifests[0].name;
  for (const manifest of manifests) {
    const installed = JSON.parse(
      await readFile(
        join(consumer, 'node_modules', manifest.name, 'package.json'),
        'utf8',
      ),
    );
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
      for (const specifier of Object.values(installed[field] ?? {}))
        assert.ok(!/^(workspace:|file:|link:|catalog:)/.test(specifier));
    if (manifest.name !== helper)
      assert.equal(installed.dependencies[helper], manifests[0].version);
  }
  const imports = extensionPackages
    .flatMap((target, index) =>
      (index === 0 ? [''] : ['', '/client', '/server']).map(
        (subpath, subindex) =>
          `import * as module${index}_${subindex} from '${target.name}${subpath}';\nvoid module${index}_${subindex};`,
      ),
    )
    .join('\n');
  await writeFile(join(consumer, 'types.ts'), imports);
  await run(
    join(
      root,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    ),
    [
      '--noEmit',
      '--strict',
      '--types',
      'node',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      'types.ts',
    ],
    consumer,
  );
  await writeFile(
    join(consumer, 'runtime.mjs'),
    `${imports}\n${await readFile(new URL('./fixtures/mcp-extension-consumer.mjs', import.meta.url), 'utf8')}`,
  );
  await run(process.execPath, ['runtime.mjs'], consumer);
  process.stdout.write(
    'MCP extension tarballs: contents, clean npm install, declaration imports, runtime imports, and shared acknowledgement dispatch verified.\n',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
