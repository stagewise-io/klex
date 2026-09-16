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
void client.v1.providers[':id'].$patch;
void client.v1['mcp-servers'].$get;
void client.v1['mcp-servers'][':name']['tool-calls'].$post;
void client.v1.introspect.$path;
async function validateMcpMetadata() {
  const response = await client.v1['mcp-servers'].$get();
  if (response.status === 200) {
    const { servers } = await response.json();
    for (const server of servers) {
      const description: string | undefined = server.serverInfo?.description;
      const icon: string | undefined = server.serverInfo?.icons?.[0]?.src;
      const instructions: string | undefined = server.instructions;
      const protocolVersion: string | undefined = server.protocolVersion;
      const protocolEra: 'legacy' | 'modern' | undefined = server.protocolEra;
      const supportedVersions: string[] | undefined = server.supportedVersions;
      const toolsChanged: boolean | undefined = server.capabilities?.tools?.listChanged;
      void [description, icon, instructions, protocolVersion, protocolEra, supportedVersions, toolsChanged];
    }
  }
}
void validateMcpMetadata;
async function validateCandidate() {
  const response = await client.v1.models.test.$post({ json: {
    provider: { id: 'my-provider' }, modelId: 'exact-model', purpose: 'chat',
    providerOptions: { openai: { reasoningEffort: 'low' } },
  } });
  if (response.status === 200) {
    const result = await response.json();
    const status: 'valid' | 'invalid' | 'unverified' | 'unsupported' = result.status;
    return status;
  }
}
void validateCandidate;
async function validateProviderCopy() {
  const response = await client.v1.providers.$get({ query: { includeSecrets: 'true' } });
  if (response.status !== 200) return;
  const exported = await response.json();
  if (exported.secretsIncluded !== true) throw new Error('Legacy source');
  for (const provider of exported.providers) {
    const knownModels: Record<string, {
      kind?: string; displayName?: string; contextSize?: number;
      capabilities?: { tools?: boolean };
    }> | undefined = provider.knownModels;
    void knownModels;
    await client.v1.providers.$post({ json: {
      id: provider.id, type: provider.type, settings: provider.settings,
      knownModels: provider.knownModels,
    } });
  }
  const selectionResponse = await client.v1.settings['model-selection'].$get();
  if (selectionResponse.status === 200) {
    const selection = await selectionResponse.json();
    await client.v1.settings['model-selection'].$patch({ json: selection });
  }
}
void validateProviderCopy;
// @ts-expect-error Export requires an explicit supported string flag.
void client.v1.providers.$get({ query: { includeSecrets: '1' } });
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
