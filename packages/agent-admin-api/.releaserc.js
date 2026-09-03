import {
  analyzeCommits as monorepoAnalyzeCommits,
  fail as monorepoFail,
  generateNotes as monorepoGenerateNotes,
  success as monorepoSuccess,
  tagFormat as monorepoTagFormat,
} from 'semantic-release-monorepo';

export default {
  branches: ['main'],
  tagFormat: monorepoTagFormat,
  analyzeCommits: monorepoAnalyzeCommits,
  generateNotes: monorepoGenerateNotes,
  success: monorepoSuccess,
  fail: monorepoFail,
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/npm',
      {
        pkgRoot: '.',
      },
    ],
    '@semantic-release/github',
  ],
};
