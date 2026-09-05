import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import {
  RELEASE_CHANNELS,
  RELEASE_TARGETS,
  type ReleaseChannel,
  type ReleaseTarget,
  resolveReleaseChannel,
} from '../release';

const receiptSchema = z
  .object({
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    binDir: z.string().min(1),
    channel: z.enum(RELEASE_CHANNELS),
    installDir: z.string().min(1),
    installedAt: z.string().min(1),
    manifestUrl: z.string().url(),
    modifiedPathFiles: z.array(z.string()).optional(),
    pathEntry: z.string().nullable().optional(),
    pathScope: z.literal('User').nullable().optional(),
    schemaVersion: z.literal(1),
    target: z.enum(RELEASE_TARGETS),
    version: z.string().min(1),
  })
  .strict();

export type InstallReceipt = z.infer<typeof receiptSchema>;

export interface ManagedInstallation {
  readonly channel: ReleaseChannel;
  readonly currentExecutable: string;
  readonly receipt: InstallReceipt;
  readonly root: string;
  readonly runningExecutable: string;
  readonly target: ReleaseTarget;
  readonly version: string;
}

export interface DiscoverInstallationOptions {
  readonly executablePath: string;
  readonly platform: NodeJS.Platform;
  readonly target: ReleaseTarget;
  readonly version: string;
  readonly onDiagnostic?: (error: unknown) => void;
}

export async function discoverManagedInstallation(
  options: DiscoverInstallationOptions,
): Promise<ManagedInstallation | null> {
  try {
    const executableName = options.platform === 'win32' ? 'klex.exe' : 'klex';
    const runningExecutable = await realpath(options.executablePath);
    const versionDirectory = dirname(runningExecutable);
    const versionsDirectory = dirname(versionDirectory);
    const root = dirname(versionsDirectory);
    if (
      dirname(executablePathFor(root, options.version, executableName)) !==
        versionDirectory ||
      resolve(runningExecutable) !==
        resolve(executablePathFor(root, options.version, executableName)) ||
      versionsDirectory !== join(root, 'versions')
    ) {
      return null;
    }

    const receiptText = await readFile(
      join(root, 'install-receipt.json'),
      'utf8',
    );
    const receipt = receiptSchema.parse(
      JSON.parse(receiptText.replace(/^\uFEFF/, '')),
    );
    const canonicalRoot = await realpath(root);
    const receiptRoot = await realpath(receipt.installDir);
    const canonicalBin = await realpath(join(root, 'bin'));
    const receiptBin = await realpath(receipt.binDir);
    if (
      canonicalRoot !== receiptRoot ||
      receipt.target !== options.target ||
      canonicalBin !== receiptBin ||
      resolveReleaseChannel(options.version) !== receipt.channel
    ) {
      return null;
    }

    const currentExecutable = join(root, 'current', executableName);
    if ((await realpath(currentExecutable)) !== runningExecutable) return null;

    return {
      channel: receipt.channel,
      currentExecutable,
      receipt,
      root,
      runningExecutable,
      target: options.target,
      version: options.version,
    };
  } catch (error) {
    options.onDiagnostic?.(error);
    return null;
  }
}

function executablePathFor(
  root: string,
  version: string,
  executableName: string,
): string {
  return join(root, 'versions', version, executableName);
}
