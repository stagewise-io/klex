import { describe, expect, it, vi } from 'vitest';

import { runImmutableInstaller } from './installer-runner';

describe('immutable installer runner', () => {
  it.runIf(process.platform !== 'win32')(
    'passes exact arguments and removes release environment overrides',
    async () => {
      const overriddenKeys = [
        'KLEX_CHANNEL',
        'KLEX_MANIFEST_URL',
        'KLEX_RELEASE_CHANNEL',
        'KLEX_RELEASE_TAG',
        'KLEX_VERSION',
      ] as const;
      const previous = Object.fromEntries(
        overriddenKeys.map((key) => [key, process.env[key]]),
      );
      for (const key of overriddenKeys) process.env[key] = 'unsafe-override';

      const script = `#!/bin/sh
set -eu
if env | grep -Eq '^(KLEX_CHANNEL|KLEX_MANIFEST_URL|KLEX_RELEASE_CHANNEL|KLEX_RELEASE_TAG|KLEX_VERSION)='; then
  exit 20
fi
[ "$1" = "--version" ]
[ "$2" = "1.2.4" ]
[ "$3" = "--install-dir" ]
[ "$4" = "/tmp/klex root" ]
[ "$5" = "--no-modify-path" ]
`;
      const fetchImplementation = vi.fn(
        async () => new Response(script, { status: 200 }),
      ) as typeof fetch;

      try {
        await expect(
          runImmutableInstaller(
            {
              gitCommit: 'a'.repeat(40),
              installRoot: '/tmp/klex root',
              platform: process.platform,
              version: '1.2.4',
            },
            fetchImplementation,
          ),
        ).resolves.toBeUndefined();
      } finally {
        for (const key of overriddenKeys) {
          const value = previous[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      expect(fetchImplementation).toHaveBeenCalledWith(
        `https://raw.githubusercontent.com/stagewise-io/klex/${'a'.repeat(40)}/install.sh`,
        expect.objectContaining({ redirect: 'error' }),
      );
    },
  );
});
