import pnpmScopes from '@commitlint/config-pnpm-scopes';

function workspaceScopeEnum({ scope }, _when, allowedScopes = []) {
  if (!scope) return [true];

  const scopes = scope.split(',');
  const invalidScopes = scopes.filter(
    (value, index) =>
      value.length === 0 ||
      value.trim() !== value ||
      scopes.indexOf(value) !== index ||
      !allowedScopes.includes(value),
  );

  return [
    invalidScopes.length === 0,
    `scope must be a comma-separated list of unique workspace names: ${allowedScopes.join(', ')}`,
  ];
}

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'workspace-scope-enum': workspaceScopeEnum,
      },
    },
  ],
  rules: {
    'scope-enum': [0],
    'workspace-scope-enum': (context) =>
      pnpmScopes.utils
        .getProjects(context)
        .then((scopes) => [
          2,
          'always',
          scopes.filter((scope) => scope !== 'global'),
        ]),
  },
};
