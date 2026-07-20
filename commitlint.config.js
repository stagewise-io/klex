import pnpmScopes from '@commitlint/config-pnpm-scopes';

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': (context) =>
      pnpmScopes.utils
        .getProjects(context)
        .then((scopes) => [
          2,
          'always',
          scopes.filter((scope) => scope !== 'global'),
        ]),
  },
};
