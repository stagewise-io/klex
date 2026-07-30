import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  CommandRunner,
  CommandRunOptions,
} from '../command-runner/index.js';
import type { NormalizedAppPackagerConfig } from '../config/index.js';
import { createSeaExecutable, createSeaWorkspace } from './sea.js';

class SeaRunner implements CommandRunner {
  readonly events: string[] = [];

  constructor(private readonly blobPath: string) {}

  run(
    command: string,
    arguments_: readonly string[],
    _options?: CommandRunOptions,
  ) {
    if (arguments_[0] === '--experimental-sea-config') {
      this.events.push('generate');
      writeFileSync(this.blobPath, 'blob');
    } else {
      this.events.push('inject');
    }
    return { command, arguments: arguments_, stdout: '', stderr: '' };
  }
}

describe('createSeaExecutable', () => {
  it('generates, copies, prepares, and only then injects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'app-packager-sea-test-'));
    try {
      const entry = join(directory, 'entry.cjs');
      writeFileSync(entry, 'console.log("ok")');
      const config = {
        name: 'order-test',
        entry,
        outputDirectory: directory,
        outputPath: join(directory, 'order-test'),
        assets: [],
        useCodeCache: false,
        signingMode: 'optional',
        macos: {},
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
      } satisfies NormalizedAppPackagerConfig;
      const workspace = createSeaWorkspace(config, join(directory, 'work'));
      const runner = new SeaRunner(workspace.blobPath);

      createSeaExecutable({
        config,
        workspace,
        runner,
        prepareRuntime: () => runner.events.push('prepare'),
      });

      expect(runner.events).toEqual(['generate', 'prepare', 'inject']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
