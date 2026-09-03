import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { CommandRunner } from '../command-runner/index.js';
import type { NormalizedAppPackagerConfig } from '../config/index.js';

const require = createRequire(import.meta.url);
const postjectCli = require.resolve('postject/dist/cli.js');
const SEA_RESOURCE_NAME = 'NODE_SEA_BLOB';
const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export interface SeaWorkspace {
  readonly directory: string;
  readonly configPath: string;
  readonly blobPath: string;
}

export interface CreateSeaExecutableOptions {
  readonly config: NormalizedAppPackagerConfig;
  readonly workspace: SeaWorkspace;
  readonly runner: CommandRunner;
  readonly prepareRuntime: () => void;
}

export function createSeaExecutable(options: CreateSeaExecutableOptions): void {
  generateSeaBlob(options.workspace, options.runner);
  copyNodeRuntime(options.config);
  options.prepareRuntime();
  injectSeaBlob(options.config, options.workspace, options.runner);
}

export function createSeaWorkspace(
  config: NormalizedAppPackagerConfig,
  directory: string,
): SeaWorkspace {
  const configPath = join(directory, 'sea-config.json');
  const blobPath = join(directory, 'sea-prep.blob');
  const assets = Object.fromEntries(
    config.assets.map((asset) => [asset.name, asset.path]),
  );
  const seaConfig = {
    main: config.entry,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    mainFormat: config.mainFormat,
    useCodeCache: config.useCodeCache,
    ...(config.assets.length > 0 ? { assets } : {}),
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(seaConfig, undefined, 2)}\n`);
  return { directory, configPath, blobPath };
}

export function generateSeaBlob(
  workspace: SeaWorkspace,
  runner: CommandRunner,
): void {
  runner.run(process.execPath, [
    '--experimental-sea-config',
    workspace.configPath,
  ]);
  if (!existsSync(workspace.blobPath)) {
    throw new Error('Node did not generate the SEA preparation blob');
  }
}

export function copyNodeRuntime(config: NormalizedAppPackagerConfig): void {
  mkdirSync(config.outputDirectory, { recursive: true });
  copyFileSync(process.execPath, config.outputPath);
}

export function injectSeaBlob(
  config: NormalizedAppPackagerConfig,
  workspace: SeaWorkspace,
  runner: CommandRunner,
): void {
  runner.run(process.execPath, [
    postjectCli,
    config.outputPath,
    SEA_RESOURCE_NAME,
    workspace.blobPath,
    '--sentinel-fuse',
    SEA_SENTINEL_FUSE,
    ...(config.platform === 'darwin'
      ? ['--macho-segment-name', 'NODE_SEA']
      : []),
  ]);
  if (!existsSync(config.outputPath)) {
    throw new Error(`Postject output is missing: ${config.outputPath}`);
  }
}
