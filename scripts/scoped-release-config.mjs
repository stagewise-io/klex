import { fileURLToPath } from 'node:url';

const scopedReleasePlugin = fileURLToPath(
  new URL('./scoped-release-plugin.mjs', import.meta.url),
);

const extensionReleasePlugin = fileURLToPath(
  new URL('./mcp-extension-release-plugin.mjs', import.meta.url),
);

export function createScopedReleaseConfig({
  packageRoot,
  scope,
  tagFormat,
  mcpExtension = false,
  // Plugins that must prepare and publish before @semantic-release/npm.
  beforeNpm = [],
}) {
  return {
    branches: ['main'],
    tagFormat,
    plugins: [
      [scopedReleasePlugin, { scope }],
      ...beforeNpm,
      [
        '@semantic-release/npm',
        {
          pkgRoot: packageRoot,
        },
      ],
      ...(mcpExtension
        ? [[extensionReleasePlugin, { pkgRoot: packageRoot, tagFormat }]]
        : []),
      '@semantic-release/github',
    ],
  };
}
