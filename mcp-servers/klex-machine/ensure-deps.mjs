import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The push-notifications schema is generated and git-ignored. Generate it only
// when missing or stale so read-only scripts never rewrite the sibling package
// and never race its own generation under turbo.
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const extensionRoot = join(
  repositoryRoot,
  'packages/mcp-extension-push-notifications',
);
const output = join(extensionRoot, 'src/generated/schema.ts');
const inputs = [
  join(extensionRoot, 'src/spec.types.ts'),
  join(extensionRoot, 'scripts/generate-schemas.ts'),
  join(extensionRoot, 'package.json'),
  join(repositoryRoot, 'scripts/generated-schema-output.ts'),
  join(repositoryRoot, 'pnpm-lock.yaml'),
];

function modifiedAt(path) {
  return statSync(path, { throwIfNoEntry: false })?.mtimeMs;
}

const outputModifiedAt = modifiedAt(output);
const stale =
  outputModifiedAt === undefined ||
  inputs.some((input) => (modifiedAt(input) ?? 0) > outputModifiedAt);

if (stale) {
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@stagewise/mcp-extension-push-notifications',
      'generate:schemas',
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  process.exit(result.status ?? 1);
}
