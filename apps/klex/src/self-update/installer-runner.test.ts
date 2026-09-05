import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it.runIf(process.platform !== 'win32')(
    'terminates the complete installer process group when cancelled',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'klex-runner-test-'));
      const pidFile = join(directory, 'pids');
      const script = `#!/bin/sh
trap '' TERM
(
  trap '' TERM
  while :; do sleep 1; done
) &
echo "$$ $!" > '${pidFile}'
wait
`;
      const controller = new AbortController();
      const run = runImmutableInstaller(
        {
          gitCommit: 'b'.repeat(40),
          installRoot: '/tmp/klex root',
          platform: process.platform,
          signal: controller.signal,
          version: '1.2.4',
        },
        vi.fn(async () => new Response(script, { status: 200 })),
      );

      try {
        const pids = await waitForPids(pidFile);
        controller.abort();
        await expect(run).rejects.toThrow(/Updater failed with signal/);
        for (const pid of pids) expect(isProcessAlive(pid)).toBe(false);
      } finally {
        controller.abort();
        await run.catch(() => undefined);
        await rm(directory, { force: true, recursive: true });
      }
    },
    10_000,
  );
});

async function waitForPids(path: string): Promise<number[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return (await readFile(path, 'utf8')).trim().split(/\s+/).map(Number);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Installer did not start in time');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code !== 'ESRCH'
    );
  }
}
