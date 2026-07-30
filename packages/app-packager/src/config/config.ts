import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export type SigningMode = 'optional' | 'required';

export interface MacOSEntitlements {
  readonly allowJit?: boolean;
  readonly allowUnsignedExecutableMemory?: boolean;
  readonly disableLibraryValidation?: boolean;
}

export interface MacOSNotarizationConfig {
  readonly enabled: true;
  readonly staple?: boolean;
}

export interface MacOSPackagingConfig {
  readonly identity?: string;
  readonly entitlements?: MacOSEntitlements;
  readonly notarization?: MacOSNotarizationConfig;
}

export interface AppSigningConfig {
  readonly mode?: SigningMode;
}

export interface AppPackagerConfig {
  readonly name: string;
  readonly entry: string;
  readonly outputDirectory: string;
  readonly assets?: Readonly<Record<string, string>>;
  readonly useCodeCache?: boolean;
  readonly expectedNodeVersion?: string;
  readonly expectedArchitecture?: NodeJS.Architecture;
  readonly signing?: AppSigningConfig;
  readonly macos?: MacOSPackagingConfig;
}

export interface ConfigContext {
  readonly baseDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly nodeVersion?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface WindowsSigningConfiguration {
  readonly signToolPath: string;
  readonly dlibPath: string;
  readonly metadataPath: string;
}

export interface MacOSNotarizationConfiguration {
  readonly appleId: string;
  readonly applePassword: string;
  readonly teamId: string;
  readonly staple: boolean;
}

export interface NormalizedAsset {
  readonly name: string;
  readonly path: string;
}

export interface NormalizedAppPackagerConfig {
  readonly name: string;
  readonly entry: string;
  readonly outputDirectory: string;
  readonly outputPath: string;
  readonly assets: readonly NormalizedAsset[];
  readonly useCodeCache: boolean;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly nodeVersion: string;
  readonly signingMode: SigningMode;
  readonly windowsSigning?: WindowsSigningConfiguration;
  readonly macos: MacOSPackagingConfig;
  readonly macosNotarization?: MacOSNotarizationConfiguration;
}

export function defineAppPackagerConfig<T extends AppPackagerConfig>(
  config: T,
): T {
  return config;
}

export function normalizeAppPackagerConfig(
  config: AppPackagerConfig,
  context: ConfigContext = {},
): NormalizedAppPackagerConfig {
  const baseDirectory = resolve(context.baseDirectory ?? process.cwd());
  const platform = context.platform ?? process.platform;
  const architecture = context.architecture ?? process.arch;
  const nodeVersion = context.nodeVersion ?? process.versions.node;
  const environment = context.environment ?? process.env;
  const signingMode = config.signing?.mode ?? 'optional';

  validateName(config.name);
  validateSigningMode(signingMode);
  if (
    config.expectedNodeVersion !== undefined &&
    config.expectedNodeVersion !== nodeVersion
  ) {
    throw new Error(
      `Node ${config.expectedNodeVersion} is required; found ${nodeVersion}`,
    );
  }
  if (
    config.expectedArchitecture !== undefined &&
    config.expectedArchitecture !== architecture
  ) {
    throw new Error(
      `Architecture ${config.expectedArchitecture} is required; found ${architecture}`,
    );
  }

  const entry = resolveFrom(baseDirectory, config.entry);
  requireFile(entry, 'Bundled entry point');
  const outputDirectory = resolveFrom(baseDirectory, config.outputDirectory);
  const executableName =
    platform === 'win32' ? `${config.name}.exe` : config.name;
  const assets = Object.entries(config.assets ?? {}).map(([name, path]) => {
    validateAssetName(name);
    const resolvedPath = resolveFrom(baseDirectory, path);
    requireFile(resolvedPath, `Asset ${name}`);
    return { name, path: resolvedPath };
  });
  const windowsSigning =
    platform === 'win32'
      ? resolveWindowsSigningConfiguration(environment, signingMode)
      : undefined;
  const macos = config.macos ?? {};
  const macosNotarization =
    platform === 'darwin' && macos.notarization?.enabled
      ? resolveMacOSNotarizationConfiguration(
          environment,
          macos.notarization.staple,
        )
      : undefined;
  if (
    platform === 'darwin' &&
    signingMode === 'required' &&
    !macos.identity?.trim()
  ) {
    throw new Error('A macOS signing identity is required in release mode');
  }

  return {
    name: config.name,
    entry,
    outputDirectory,
    outputPath: join(outputDirectory, executableName),
    assets,
    useCodeCache: config.useCodeCache ?? true,
    platform,
    architecture,
    nodeVersion,
    signingMode,
    ...(windowsSigning ? { windowsSigning } : {}),
    macos,
    ...(macosNotarization ? { macosNotarization } : {}),
  };
}

export function resolveWindowsSigningConfiguration(
  environment: NodeJS.ProcessEnv,
  mode: SigningMode,
): WindowsSigningConfiguration | undefined {
  const values = {
    signToolPath: normalized(environment.SIGNTOOL_PATH),
    dlibPath: normalized(environment.AZURE_CODE_SIGNING_DLIB),
    metadataPath: normalized(environment.AZURE_METADATA_JSON),
  };
  const configuredCount = Object.values(values).filter(Boolean).length;
  if (configuredCount === 0) {
    if (mode === 'required') {
      throw new Error('Windows signing configuration is required');
    }
    return undefined;
  }
  if (configuredCount !== 3) {
    throw new Error('Windows signing configuration is incomplete');
  }
  requireFile(values.signToolPath as string, 'SIGNTOOL_PATH');
  requireFile(values.dlibPath as string, 'AZURE_CODE_SIGNING_DLIB');
  requireFile(values.metadataPath as string, 'AZURE_METADATA_JSON');
  return values as WindowsSigningConfiguration;
}

export function resolveMacOSNotarizationConfiguration(
  environment: NodeJS.ProcessEnv,
  staple: boolean | undefined,
): MacOSNotarizationConfiguration {
  const appleId = normalized(environment.APPLE_ID);
  const applePassword = normalized(environment.APPLE_PASSWORD);
  const teamId = normalized(environment.APPLE_TEAM_ID);
  if (!appleId || !applePassword || !teamId) {
    throw new Error(
      'macOS notarization requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID',
    );
  }
  return { appleId, applePassword, teamId, staple: staple ?? false };
}

function validateName(name: string): void {
  if (!name.trim() || name !== name.trim()) {
    throw new Error('Executable name must not be empty or padded');
  }
  if (name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw new Error('Executable name must be a file name, not a path');
  }
}

function validateSigningMode(mode: string): asserts mode is SigningMode {
  if (mode !== 'optional' && mode !== 'required') {
    throw new Error('Signing mode must be optional or required');
  }
}

function validateAssetName(name: string): void {
  if (!name.trim() || name !== name.trim()) {
    throw new Error('SEA asset names must not be empty or padded');
  }
}

function requireFile(path: string, description: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${description} does not exist: ${path}`);
  }
}

function resolveFrom(baseDirectory: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(baseDirectory, path);
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}
