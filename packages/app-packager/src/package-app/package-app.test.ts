import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { packageApp } from './package-app.js';

const directory = mkdtempSync(join(tmpdir(), 'app-packager-smoke-'));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('packageApp native smoke test', () => {
  it.skipIf(process.platform === 'win32')(
    'packages, signs when supported, executes, and reports metadata',
    async () => {
      const entry = join(directory, 'entry.cjs');
      const asset = join(directory, 'message.txt');
      writeFileSync(
        entry,
        "const { getAsset } = require('node:sea'); process.stdout.write(getAsset('message', 'utf8'));",
      );
      writeFileSync(asset, 'native-smoke-ok');
      const artifact = await packageApp(
        {
          name: 'native-smoke',
          entry,
          outputDirectory: join(directory, 'release'),
          assets: { message: asset },
        },
        { baseDirectory: directory },
      );

      expect(existsSync(artifact.outputPath)).toBe(true);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.assets).toEqual(['message']);
      if (process.platform === 'darwin') {
        expect(artifact).toMatchObject({ signed: true, verified: true });
      }
      chmodSync(artifact.outputPath, 0o755);
      const execution = spawnSync(artifact.outputPath, [], {
        encoding: 'utf8',
      });
      expect(
        execution.status,
        `${execution.error?.message ?? ''}\nsignal=${execution.signal ?? ''}\n${execution.stderr}`,
      ).toBe(0);
      expect(execution.stdout).toBe('native-smoke-ok');
    },
    60_000,
  );
});
