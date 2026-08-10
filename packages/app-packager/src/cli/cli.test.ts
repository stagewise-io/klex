import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { isMainModule } from './cli.js';

const directory = mkdtempSync(join(tmpdir(), 'app-packager-cli-'));
const target = join(directory, 'cli.js');
writeFileSync(target, '');

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('isMainModule', () => {
  it('recognizes a direct CLI entry point', () => {
    expect(isMainModule(target, pathToFileURL(target).href)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'recognizes a package-manager bin symlink',
    () => {
      const link = join(directory, 'app-packager');
      symlinkSync(target, link);
      expect(isMainModule(link, pathToFileURL(target).href)).toBe(true);
    },
  );
});
