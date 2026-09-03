import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageDirectory = new URL('.', import.meta.url);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'agent-admin-api-package-'),
);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    { cwd: packageDirectory, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const consumerDirectory = join(temporaryDirectory, 'consumer');
  const tarballPath = join(temporaryDirectory, filename);

  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    join(consumerDirectory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@hono/zod-openapi': '1.5.1',
          '@klex/agent-admin-api': `file:${tarballPath}`,
          hono: '4.12.30',
          typescript: '5.9.3',
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(consumerDirectory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
        },
        include: ['index.ts'],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(consumerDirectory, 'index.ts'),
    `import { hc } from 'hono/client';
import type { AdminApi } from '@klex/agent-admin-api';

const client = hc<AdminApi>('https://agent.example');
void client.v1.health.$get;
void client.v1.providers.$get;
void client.v1.providers[':name'].$patch;
void client.v1['mcp-servers'].$get;
void client.v1.introspect.$path;
`,
  );

  run('pnpm', ['install', '--frozen-lockfile=false'], consumerDirectory);
  run('pnpm', ['exec', 'tsc'], consumerDirectory);

  const declaration = await readFile(
    join(
      consumerDirectory,
      'node_modules/@klex/agent-admin-api/dist/index.d.ts',
    ),
    'utf8',
  );
  if (
    /@stagewise\/klex|@\/|apps\/klex|AdminAppDependencies|ModuleLogger|ModelCallLogger/.test(
      declaration,
    )
  ) {
    throw new Error(
      'Packed declaration leaks private Klex implementation types',
    );
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
