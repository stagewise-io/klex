import { analyzeCommits as analyzeConventionalCommits } from '@semantic-release/commit-analyzer';
import { generateNotes as generateConventionalNotes } from '@semantic-release/release-notes-generator';

export function commitHasScope(message, expectedScope) {
  const header = message.split('\n', 1)[0];
  const match = /^[a-z][a-z0-9-]*\(([^)]+)\)(?:!)?:/i.exec(header);

  return match?.[1].split(',').includes(expectedScope) ?? false;
}

function scopedCommits(scope, commits) {
  return commits.filter(({ message }) => commitHasScope(message, scope));
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
