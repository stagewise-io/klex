import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  assertReleaseVersion,
  type Channel,
  manifestUrl,
  parseChannel,
} from './targets.ts';

export const PUBLIC_KEY_PATH = fileURLToPath(
  new URL('../../src-tauri/updater.pub', import.meta.url),
);
const WINDOWS_SIGN_SCRIPT = fileURLToPath(
  new URL('../sign-windows.ps1', import.meta.url),
);

export interface ReleaseConfigOptions {
  readonly channel: Channel;
  readonly publicKey: string;
  readonly repository: string;
  readonly version: string;
  readonly windowsSignScript: string;
}

/**
 * Overlay merged over `tauri.conf.json` with `tauri build --config`. Only
 * release builds carry the updater, so development and CI builds never
 * check for updates and need no signing key.
 */
export function createReleaseConfig(options: ReleaseConfigOptions) {
  assertReleaseVersion(options.channel, options.version);
  const publicKey = options.publicKey.trim();
  if (!publicKey) throw new Error('The updater public key is empty');
  return {
    version: options.version,
    bundle: {
      createUpdaterArtifacts: true,
      windows: {
        signCommand: {
          cmd: 'pwsh',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            options.windowsSignScript,
            '%1',
          ],
        },
      },
    },
    plugins: {
      updater: {
        pubkey: publicKey,
        endpoints: [manifestUrl(options.repository, options.channel)],
        requireSignedVersion: true,
        windows: { installMode: 'passive' },
      },
    },
  };
}

export function readPublicKey(path = PUBLIC_KEY_PATH): string {
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Generate the updater key pair with \`pnpm --filter @klex/desktop tauri signer generate\`, ` +
        'store the private key and its password as the TAURI_SIGNING_PRIVATE_KEY and ' +
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD secrets of the Release environment, and commit the public key there.',
    );
  }
  return readFileSync(path, 'utf8');
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      output: { type: 'string' },
      repository: { type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  const { channel, output, repository, version } = values;
  if (!channel || !output || !repository || !version) {
    throw new Error(
      '--channel, --output, --repository and --version are required',
    );
  }
  const config = createReleaseConfig({
    channel: parseChannel(channel),
    publicKey: readPublicKey(),
    repository,
    version,
    windowsSignScript: WINDOWS_SIGN_SCRIPT,
  });
  writeFileSync(output, `${JSON.stringify(config, undefined, 2)}\n`);
}
