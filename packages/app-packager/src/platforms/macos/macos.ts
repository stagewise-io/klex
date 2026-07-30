import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandRunner } from '../../command-runner/index.js';
import type { MacOSNotarizationConfiguration } from '../../config/index.js';
import type {
  PlatformSigningOptions,
  SigningResult,
} from '../../signing/signing.js';

export function prepareMacOSRuntime(file: string, runner: CommandRunner): void {
  runner.run('codesign', ['--remove-signature', file]);
}

export function stripMacOSExecutable(
  file: string,
  runner: CommandRunner,
): void {
  runner.run('strip', ['-x', file]);
}

export function signMacOSExecutable(
  options: PlatformSigningOptions,
): SigningResult {
  const identity = options.macos.identity?.trim();
  if (options.mode === 'required' && !identity) {
    throw new Error('A macOS signing identity is required in release mode');
  }

  const workspace = mkdtempSync(join(tmpdir(), 'app-packager-signing-'));
  const entitlementsPath = join(workspace, 'entitlements.plist');
  try {
    writeFileSync(
      entitlementsPath,
      createEntitlements(options.macos.entitlements ?? {}),
    );
    options.runner.run(
      'codesign',
      identity
        ? [
            '--force',
            '--options',
            'runtime',
            '--entitlements',
            entitlementsPath,
            '--sign',
            identity,
            options.file,
          ]
        : ['--force', '--sign', '-', options.file],
    );
    verifyMacOSExecutable(options);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  return {
    signed: true,
    verified: true,
    provider: identity ? 'apple-developer-id' : 'apple-ad-hoc',
  };
}

export function verifyMacOSExecutable(
  options: PlatformSigningOptions,
): SigningResult {
  options.runner.run('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    options.file,
  ]);
  return {
    signed: true,
    verified: true,
    provider: options.macos.identity ? 'apple-developer-id' : 'apple-ad-hoc',
  };
}

export function notarizeMacOSExecutable(
  file: string,
  configuration: MacOSNotarizationConfiguration,
  runner: CommandRunner,
): void {
  const workspace = mkdtempSync(join(tmpdir(), 'app-packager-notarize-'));
  const zipPath = join(workspace, 'submission.zip');
  try {
    runner.run('ditto', ['-c', '-k', '--keepParent', file, zipPath]);
    runner.run(
      'xcrun',
      [
        'notarytool',
        'submit',
        zipPath,
        '--apple-id',
        configuration.appleId,
        '--password',
        configuration.applePassword,
        '--team-id',
        configuration.teamId,
        '--wait',
      ],
      { sensitiveArgumentIndexes: [4, 6, 8] },
    );
    if (configuration.staple) {
      runner.run('xcrun', ['stapler', 'staple', file]);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function createEntitlements(
  entitlements: NonNullable<PlatformSigningOptions['macos']['entitlements']>,
): string {
  const entries = [
    ['com.apple.security.cs.allow-jit', entitlements.allowJit],
    [
      'com.apple.security.cs.allow-unsigned-executable-memory',
      entitlements.allowUnsignedExecutableMemory,
    ],
    [
      'com.apple.security.cs.disable-library-validation',
      entitlements.disableLibraryValidation,
    ],
  ]
    .filter((entry): entry is [string, boolean] => entry[1] !== undefined)
    .map(([key, enabled]) => `  <key>${key}</key>\n  <${enabled}/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}
