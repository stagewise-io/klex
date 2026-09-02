import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CommandRunner,
  createCommandRunner,
} from '../command-runner/index.js';
import {
  type AppPackagerConfig,
  type ConfigContext,
  normalizeAppPackagerConfig,
} from '../config/index.js';
import { getPlatformAdapter } from '../platforms/index.js';
import { createSeaExecutable, createSeaWorkspace } from '../sea/index.js';
import type { SigningProvider } from '../signing/index.js';

export interface PackageAppContext extends ConfigContext {
  readonly runner?: CommandRunner;
}

export interface PackagedAppArtifact {
  readonly outputPath: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly nodeVersion: string;
  readonly sha256: string;
  readonly assets: readonly string[];
  readonly signed: boolean;
  readonly verified: boolean;
  readonly signingProvider?: SigningProvider;
  readonly notarized: boolean;
}

export async function packageApp(
  input: AppPackagerConfig,
  context: PackageAppContext = {},
): Promise<PackagedAppArtifact> {
  const config = normalizeAppPackagerConfig(input, context);
  const runner = context.runner ?? createCommandRunner();
  const adapter = getPlatformAdapter(config.platform);
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'stagewise-app-packager-'),
  );
  const workspace = createSeaWorkspace(config, temporaryDirectory);
  let completed = false;

  try {
    createSeaExecutable({
      config,
      workspace,
      runner,
      prepareRuntime: () => {
        adapter.prepareRuntime(
          config.outputPath,
          runner,
          context.environment ?? process.env,
        );
        adapter.strip(config.outputPath, runner);
      },
    });
    if (config.platform !== 'win32') chmodSync(config.outputPath, 0o755);
    const signature = adapter.sign({
      file: config.outputPath,
      mode: config.signingMode,
      macos: config.macos,
      environment: context.environment ?? process.env,
      runner,
      ...(config.windowsSigning
        ? { windowsSigning: config.windowsSigning }
        : {}),
    });
    if (config.macosNotarization) {
      adapter.notarize(config.outputPath, config.macosNotarization, runner);
    }
    const sha256 = await hashFile(config.outputPath);
    completed = true;
    return {
      outputPath: config.outputPath,
      platform: config.platform,
      architecture: config.architecture,
      nodeVersion: config.nodeVersion,
      sha256,
      assets: config.assets.map((asset) => asset.name),
      signed: signature.signed,
      verified: signature.verified,
      ...(signature.provider ? { signingProvider: signature.provider } : {}),
      notarized: config.macosNotarization !== undefined,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    if (!completed) rmSync(config.outputPath, { force: true });
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
