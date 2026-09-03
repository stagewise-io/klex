export default {
  branches: ['main'],
  tagFormat: '@klex/agent-admin-api-v${version}',
  plugins: [
    ['./release-plugin.mjs', { scope: 'agent-admin-api' }],
    [
      '@semantic-release/npm',
      {
        pkgRoot: '.',
      },
    ],
    '@semantic-release/github',
  ],
};
