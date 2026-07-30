import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  type AppPackagerConfig,
  type PackagedAppArtifact,
  packageApp,
} from '@stagewise/app-packager';

const ROOT = resolve(import.meta.dirname, '..');

export interface FluidAgentPackagingOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly skipNotarize?: boolean;
}

export function createFluidAgentPackagerConfig(
  options: FluidAgentPackagingOptions = {},
): AppPackagerConfig {
  const environment = options.environment ?? process.env;
  const identity = environment.APPLE_SIGNING_IDENTITY?.trim();
  const shouldNotarize =
    !options.skipNotarize &&
    Boolean(
      environment.APPLE_ID &&
        environment.APPLE_PASSWORD &&
        environment.APPLE_TEAM_ID,
    );

  return {
    name: 'fluid-agent',
    entry: 'dist/main.js',
    outputDirectory: 'dist',
    assets: {
      'javascript-sandbox-worker.js': 'dist/javascript-sandbox-worker.js',
    },
    useCodeCache: true,
    signing: { mode: 'optional' },
    macos: {
      ...(identity ? { identity } : {}),
      entitlements: {
        allowJit: true,
        allowUnsignedExecutableMemory: true,
        disableLibraryValidation: true,
      },
      ...(shouldNotarize
        ? { notarization: { enabled: true, staple: true } as const }
        : {}),
    },
  };
}

export async function packageFluidAgent(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PackagedAppArtifact> {
  const normalizedArguments = arguments_.filter(
    (argument) => argument !== '--',
  );
  const { values } = parseArgs({
    args: normalizedArguments,
    options: {
      'skip-notarize': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const config = createFluidAgentPackagerConfig({
    environment,
    skipNotarize: values['skip-notarize'],
  });
  return packageApp(config, {
    baseDirectory: ROOT,
    environment,
  });
}

async function main(): Promise<void> {
  const artifact = await packageFluidAgent(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(artifact, undefined, 2)}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
