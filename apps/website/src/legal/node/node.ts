import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMap, isScalar, parseDocument } from 'yaml';

import {
  assert,
  type Catalog,
  date,
  keys,
  MAX_DOCUMENT_BYTES,
  MAX_RENDERED_BYTES,
  object,
  origin,
  PUBLIC_ORIGIN,
  revisionPath,
  slug,
} from '../legal.ts';
import { renderMarkdown } from './markdown.ts';

export interface PolicyType {
  slug: string;
  label: string;
}
export interface Registry {
  schemaVersion: 1;
  policies: PolicyType[];
}
export interface SourceRevision {
  policy: string;
  revision: string;
  source: string;
  effectiveDate: string;
  sha256: string;
  requiresConsent: boolean;
  title: string;
  changeSummary?: string;
  body: string;
  bytes: Buffer;
}
export interface LegalSources {
  registry: Registry;
  revisions: SourceRevision[];
}

function text(value: unknown, max = 300): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Plain-text legal metadata must reject all ASCII control characters.
  const controls = /[\u0000-\u001f\u007f]/;
  assert(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= max &&
      !controls.test(value),
    'Expected bounded plain-text metadata',
  );
  return value;
}

export function validateRegistry(value: unknown): Registry {
  const root = object(value);
  keys(root, ['schemaVersion', 'policies']);
  assert(
    root.schemaVersion === 1 && Array.isArray(root.policies),
    'Invalid policy registry',
  );
  const seen = new Set<string>();
  const policies = root.policies.map((value) => {
    const entry = object(value);
    keys(entry, ['slug', 'label']);
    const policy = slug(entry.slug);
    assert(!seen.has(policy), 'Duplicate policy type');
    seen.add(policy);
    return { slug: policy, label: text(entry.label) };
  });
  assert(
    seen.has('privacy') && seen.has('terms'),
    'Privacy and terms must be defined',
  );
  return { schemaVersion: 1, policies };
}

export function parseSource(
  bytes: Buffer,
  source: string,
  registry: Registry,
): SourceRevision {
  assert(bytes.length <= MAX_DOCUMENT_BYTES, 'Policy exceeds 2 MiB');
  assert(
    !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
    'UTF-8 BOM is not permitted',
  );
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(
    !raw.includes('\r') && !raw.includes('\0'),
    'Policy must use LF with no NUL bytes',
  );
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(raw);
  assert(
    match && match[1].length <= 8192,
    'Missing or oversized YAML frontmatter',
  );
  const document = parseDocument(match[1], {
    schema: 'failsafe',
    uniqueKeys: true,
  });
  assert(
    document.errors.length === 0 &&
      document.warnings.length === 0 &&
      isMap(document.contents),
    'Invalid YAML frontmatter',
  );
  assert(
    document.contents.items.every(
      (pair) =>
        isScalar(pair.key) &&
        isScalar(pair.value) &&
        !pair.key.anchor &&
        !pair.value.anchor &&
        !pair.key.tag &&
        !pair.value.tag,
    ),
    'Frontmatter must be a flat, untagged scalar map without aliases',
  );
  const metadata = object(document.toJS({ maxAliasCount: 0 }));
  keys(metadata, ['title'], ['changeSummary', 'requiresConsent']);
  // The failsafe YAML schema preserves text scalars; accept only plain boolean literals here.
  const consent = document.get('requiresConsent', true);
  assert(
    consent === undefined ||
      (isScalar(consent) &&
        consent.type === 'PLAIN' &&
        (consent.value === 'true' || consent.value === 'false')),
    'requiresConsent must be an unquoted true or false',
  );
  const identity = /^([a-z][a-z0-9-]*)\/([1-9]\d{3}-\d{2}-\d{2})\.md$/.exec(
    source,
  );
  assert(identity, 'Expected policy/YYYY-MM-DD.md source path');
  const policy = slug(identity[1]);
  const revision = date(identity[2]);
  assert(
    registry.policies.some((type) => type.slug === policy),
    'Unknown policy type',
  );
  const body = match[2];
  assert(body.trim().length > 0, 'Policy body must not be empty');
  assert(
    Buffer.byteLength(renderMarkdown(body)) <= MAX_RENDERED_BYTES,
    'Rendered policy is too large',
  );
  return {
    policy,
    revision,
    source,
    effectiveDate: revision,
    requiresConsent: consent?.value === 'true',
    title: text(metadata.title),
    ...(metadata.changeSummary === undefined
      ? {}
      : { changeSummary: text(metadata.changeSummary, 1000) }),
    body,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function regularFile(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_DOCUMENT_BYTES,
    `Not a bounded regular file: ${path}`,
  );
  return readFile(path);
}

async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    `Not a regular directory: ${path}`,
  );
}

export interface LegalSource {
  load(): Promise<LegalSources>;
}

class LegalSourceModule implements LegalSource {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }

  async load(): Promise<LegalSources> {
    await directory(this.root);
    const registry = validateRegistry(
      JSON.parse(
        (await regularFile(join(this.root, 'policies.json'))).toString('utf8'),
      ),
    );
    const files: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name === 'policies.json') continue;
      assert(
        entry.isDirectory() &&
          registry.policies.some((type) => type.slug === entry.name),
        `Unexpected legal source entry: ${entry.name}`,
      );
      const folder = join(this.root, entry.name);
      await directory(folder);
      for (const file of await readdir(folder, { withFileTypes: true })) {
        assert(
          file.isFile() && /^[1-9]\d{3}-\d{2}-\d{2}\.md$/.test(file.name),
          `Unexpected policy source: ${file.name}`,
        );
        files.push(`${entry.name}/${file.name}`);
      }
    }
    const revisions: SourceRevision[] = [];
    for (const source of files.sort()) {
      const parsed = parseSource(
        await regularFile(join(this.root, source)),
        source,
        registry,
      );
      revisions.push(parsed);
    }
    return { registry, revisions };
  }
}

export function createLegalSource(root: string): LegalSource {
  return new LegalSourceModule(root);
}

export function createCatalog(
  sources: LegalSources,
  siteOrigin = PUBLIC_ORIGIN,
): Catalog {
  origin(siteOrigin);
  const policies: Catalog['policies'] = Object.create(null);
  for (const type of sources.registry.policies) {
    policies[type.slug] = sources.revisions
      .filter((entry) => entry.policy === type.slug)
      .sort((a, b) => b.revision.localeCompare(a.revision))
      .map((entry) => ({
        revision: entry.revision,
        effectiveDate: entry.effectiveDate,
        requiresConsent: entry.requiresConsent,
        url: `${siteOrigin}${revisionPath(entry.policy, entry.revision)}`,
        markdownUrl: `${siteOrigin}${revisionPath(entry.policy, entry.revision)}.md`,
        sha256: entry.sha256,
      }));
  }
  return { schemaVersion: 1, policies };
}
