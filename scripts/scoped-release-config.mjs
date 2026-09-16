import { fileURLToPath } from 'node:url';

const scopedReleasePlugin = fileURLToPath(
  new URL('./scoped-release-plugin.mjs', import.meta.url),
);

export function createScopedReleaseConfig({ packageRoot, scope, tagFormat }) {
  return {
    branches: ['main'],
    tagFormat,
    plugins: [
      [scopedReleasePlugin, { scope }],
      [
        '@semantic-release/npm',
        {
          pkgRoot: packageRoot,
        },
      ],
      '@semantic-release/github',
    ],
  };
}
