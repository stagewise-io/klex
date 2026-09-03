import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer';
import { generateNotes as generateConventionalNotes } from '@semantic-release/release-notes-generator';

function scopedCommits(scope, commits) {
  const escapedScope = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scopedHeader = new RegExp(
    `^[a-z][a-z0-9-]*\\(${escapedScope}\\)(?:!)?:`,
    'i',
  );
  return commits.filter(({ message }) =>
    scopedHeader.test(message.split('\n', 1)[0]),
  );
}

export async function generateNotes({ scope }, context) {
  return generateConventionalNotes(
    {},
    {
      ...context,
      commits: scopedCommits(scope, context.commits),
    },
  );
}

export async function analyzeCommits({ scope }, context) {
  const commits = scopedCommits(scope, context.commits);

  if (commits.length === 0) {
    context.logger.log('No %s scoped commits found', scope);
    return null;
  }

  return analyzeConventionalCommits(
    {
      releaseRules: [
        { breaking: true, release: 'major' },
        { type: 'feat', release: 'minor' },
        { release: 'patch' },
      ],
    },
    { ...context, commits },
  );
}
