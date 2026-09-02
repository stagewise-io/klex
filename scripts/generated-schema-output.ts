import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const biomePath = require.resolve('@biomejs/biome/bin/biome');

function displayPath(filePath: string): string {
  return relative(repositoryRoot, filePath).replaceAll('\\', '/');
}

function getErrorStderr(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return undefined;
  }

  const stderr = String(error.stderr).trim();
  return stderr.length > 0 ? stderr : undefined;
}

export function canonicalizeGeneratedOutput(
  content: string,
  filePath: string,
): string {
  const repositoryFilePath = relative(repositoryRoot, filePath);

  try {
    return execFileSync(
      process.execPath,
      [
        biomePath,
        'check',
        '--write',
        `--stdin-file-path=${repositoryFilePath}`,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        input: content,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const stderr = getErrorStderr(error);
    const detail =
      stderr ?? (error instanceof Error ? error.message : String(error));
    throw new Error(
      `Biome failed to canonicalize ${displayPath(filePath)}:\n${detail}`,
      { cause: error },
    );
  }
}

interface GeneratedOutput {
  readonly expected: string;
  readonly filePath: string;
}

export function assertGeneratedOutputsCurrent(
  outputs: readonly GeneratedOutput[],
): void {
  const issues = outputs.flatMap(({ expected, filePath }) => {
    const path = displayPath(filePath);
    if (!existsSync(filePath)) {
      return `${path} does not exist`;
    }
    if (readFileSync(filePath, 'utf8') !== expected) {
      return `${path} is stale`;
    }
    return [];
  });

  if (issues.length > 0) {
    throw new Error(`${issues.join('\n')}; run \`pnpm generate:schemas\``);
  }
}
