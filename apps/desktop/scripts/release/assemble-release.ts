import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { metadataName, type TargetMetadata } from './collect-artifacts.ts';
import { signedVersion, verifyUpdaterSignature } from './minisign.ts';
import { readPublicKey } from './release-config.ts';
import {
  assertReleaseVersion,
  type Channel,
  defaultUpdateBundle,
  parseChannel,
  releaseTag,
  TARGETS,
} from './targets.ts';

export interface UpdateManifest {
  readonly version: string;
  readonly notes: string;
  readonly pub_date: string;
  readonly platforms: Record<string, { url: string; signature: string }>;
}

export interface AssembleOptions {
  readonly channel: Channel;
  readonly directory: string;
  readonly notes: string;
  readonly publicKey: string;
  readonly publishedAt: Date;
  readonly repository: string;
  readonly version: string;
}

/**
 * Checks every target's bundles and updater signatures, then writes the
 * channel's Tauri `latest.json` and `checksums.txt` next to them. The
 * published files are exactly the ones `checksums.txt` lists, plus both.
 */
export function assembleRelease(options: AssembleOptions): {
  manifest: UpdateManifest;
  files: string[];
} {
  assertReleaseVersion(options.channel, options.version);
  const tag = releaseTag(options.version);
  const present = new Set(readdirSync(options.directory));
  const expected = new Set<string>();
  const platforms: UpdateManifest['platforms'] = {};
  for (const target of TARGETS) {
    const name = metadataName(target.id);
    if (!present.has(name))
      throw new Error(`Missing build output for ${target.id}`);
    expected.add(name);
    const metadata = JSON.parse(
      readFileSync(join(options.directory, name), 'utf8'),
    ) as TargetMetadata;
    if (metadata.target !== target.id || metadata.version !== options.version) {
      throw new Error(
        `${name} describes ${metadata.target} ${metadata.version}, expected ${target.id} ${options.version}`,
      );
    }
    for (const file of metadata.files) {
      if (!present.has(file))
        throw new Error(`Missing ${file} for ${target.id}`);
      expected.add(file);
    }
    const installers = target.bundles.flatMap((bundle) =>
      bundle.installer ? [bundle.installer] : [],
    );
    const updates = metadata.updates.map((update) => update.installer).sort();
    if (updates.join() !== [...installers].sort().join()) {
      throw new Error(
        `${target.id} has updates for ${updates.join(', ')}, expected ${installers.join(', ')}`,
      );
    }
    for (const update of metadata.updates) {
      const data = readFileSync(join(options.directory, update.file));
      const comment = verifyUpdaterSignature(
        options.publicKey,
        update.signature,
        data,
      );
      if (signedVersion(comment) !== options.version) {
        throw new Error(
          `${update.file} is signed for version ${signedVersion(comment) ?? '(none)'}, expected ${options.version}`,
        );
      }
      const entry = {
        url: `https://github.com/${options.repository}/releases/download/${tag}/${update.file}`,
        signature: update.signature,
      };
      platforms[`${target.platform}-${update.installer}`] = entry;
      if (update.installer === defaultUpdateBundle(target).installer) {
        platforms[target.platform] = entry;
      }
    }
  }
  const unexpected = [...present].filter((file) => !expected.has(file));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected release files: ${unexpected.join(', ')}`);
  }
  const files = [...expected]
    .filter((file) => !file.startsWith('target-'))
    .sort();
  const checksums = files
    .map((file) => {
      const hash = createHash('sha256')
        .update(readFileSync(join(options.directory, file)))
        .digest('hex');
      return `${hash}  ${file}\n`;
    })
    .join('');
  const manifest: UpdateManifest = {
    version: options.version,
    notes: options.notes,
    pub_date: options.publishedAt.toISOString(),
    platforms,
  };
  writeFileSync(join(options.directory, 'checksums.txt'), checksums);
  writeFileSync(
    join(options.directory, 'latest.json'),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  return { manifest, files };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      channel: { type: 'string' },
      directory: { type: 'string' },
      'notes-file': { type: 'string' },
      repository: { type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  const { channel, directory, repository, version } = values;
  if (!channel || !directory || !repository || !version) {
    throw new Error(
      '--channel, --directory, --repository and --version are required',
    );
  }
  const notesFile = values['notes-file'];
  const { files } = assembleRelease({
    channel: parseChannel(channel),
    directory,
    notes: notesFile
      ? readFileSync(notesFile, 'utf8').trim()
      : `Klex Desktop ${version}`,
    publicKey: readPublicKey(),
    publishedAt: new Date(),
    repository,
    version,
  });
  process.stdout.write(`${files.join('\n')}\n`);
}
