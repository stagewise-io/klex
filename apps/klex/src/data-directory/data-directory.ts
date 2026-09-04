import { mkdir } from 'node:fs/promises';

// Owner-only: the data directory holds config, credentials, cloud enrollment
// state and model-call logs. Ignored on Windows, where ACLs apply instead.
const DATA_DIRECTORY_MODE = 0o700;

/**
 * Creates the agent data directory, including missing parents.
 *
 * Nothing else in the startup path provisions it: the directory lock is the
 * first writer and opens its lock file with `wx`, which fails with ENOENT when
 * the parent is absent. Since the data directory defaults to
 * `$KLEX_HOME/agents/default` rather than the working directory, a first run on
 * a fresh machine has no existing directory to fall back on.
 *
 * Idempotent — an existing directory is left untouched, permissions included.
 */
export async function ensureDataDirectory(
  dataDirectory: string,
): Promise<void> {
  try {
    await mkdir(dataDirectory, { recursive: true, mode: DATA_DIRECTORY_MODE });
  } catch (error) {
    throw new Error(
      `Failed to create the agent data directory at "${dataDirectory}". ` +
        'Pass --data-dir or set KLEX_HOME to a writable location.',
      { cause: error },
    );
  }
}
