import { writeFile } from 'node:fs/promises';

/** Subdirectory within the working directory that holds identity and enrollment files. */
export const IDENTITY_DIR = 'identity';

/**
 * Write a JSON file with restrictive permissions (0o600).
 * The content is pretty-printed with a trailing newline.
 */
export async function writeSecureJsonFile(
  filePath: string,
  data: unknown,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
