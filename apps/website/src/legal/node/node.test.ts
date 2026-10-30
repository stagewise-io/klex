import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFooterMarkup } from '@/new/sections/footer';

import {
  fixtureSources,
  registry,
  syntheticMarkdown,
  template,
} from '../fixtures';
import { renderMarkdown } from './markdown';
import {
  createCatalog,
  createLegalSource,
  parseSource,
  validateRegistry,
} from './node';
import { generateArtifacts, resolveLegalRequest } from './render';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function content() {
  const directory = await mkdtemp(join(tmpdir(), 'klex-legal-source-'));
  directories.push(directory);
  await writeFile(join(directory, 'policies.json'), JSON.stringify(registry));
  await mkdir(join(directory, 'privacy'));
  return { directory, source: createLegalSource(directory) };
}
const original = syntheticMarkdown('privacy', '2020-01-01');
const parse = (bytes: Buffer) =>
  parseSource(bytes, 'privacy/2020-01-01.md', registry);

describe('source discovery, validation and build-time hashes', () => {
  it('derives policy, revision and effective date from the source path alone', () => {
    const revision = parse(original);
    expect(revision.policy).toBe('privacy');
    expect(revision.revision).toBe('2020-01-01');
    expect(revision.effectiveDate).toBe('2020-01-01');
    expect(original.toString()).not.toMatch(
      /^(policy|revision|effectiveDate):/m,
    );
  });
  it.each([
    'privacy/2020-02-30.md',
    'privacy/2021-02-29.md',
    'privacy/2020-1-01.md',
    'privacy/0000-01-01.md',
    'privacy/2020-01-01.txt',
    '../privacy/2020-01-01.md',
    'privacy/nested/2020-01-01.md',
    'missing/2020-01-01.md',
  ])('rejects invalid or undeclared source paths: %s', (path) => {
    expect(() => parseSource(original, path, registry)).toThrow();
  });
  it('uses exact source bytes for the digest and preserves frontmatter', () => {
    expect(parse(original).sha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
    expect(parse(original).bytes).toBe(original);
  });
  it.each([true, false, undefined])(
    'parses requiresConsent %s as boolean metadata without changing source bytes',
    (requiresConsent) => {
      const bytes = syntheticMarkdown('privacy', '2020-01-01', requiresConsent);
      const revision = parse(bytes);
      expect(revision.requiresConsent).toBe(requiresConsent ?? false);
      expect(revision.bytes).toBe(bytes);
      expect(revision.sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    },
  );
  it.each([
    '"true"',
    "'false'",
    'yes',
    'no',
    '1',
    '0',
    'null',
    '',
    'TRUE',
    'False',
    '[true]',
    '{ value: true }',
    '!!bool true',
    '&consent true',
  ])('rejects nonboolean requiresConsent: %s', (value) => {
    const bytes = Buffer.from(
      original
        .toString()
        .replace('changeSummary:', `requiresConsent: ${value}\nchangeSummary:`),
    );
    expect(() => parse(bytes)).toThrow();
  });
  it.each([
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
    Buffer.from(original.toString().replaceAll('\n', '\r\n')),
    Buffer.from([0xff]),
    Buffer.from(`${original}\0`),
    ...['policy', 'revision', 'effectiveDate'].map((field) =>
      Buffer.from(
        original.toString().replace('title:', `${field}: redundant\ntitle:`),
      ),
    ),
    Buffer.from(
      original
        .toString()
        .replace(
          'title: Synthetic privacy 2020-01-01',
          'title: One\ntitle: Two',
        ),
    ),
    Buffer.from(
      original
        .toString()
        .replace('title: Synthetic privacy 2020-01-01', 'title: { x: nested }'),
    ),
    Buffer.from(
      original
        .toString()
        .replace('title: Synthetic privacy 2020-01-01', 'title: &title Alias'),
    ),
    Buffer.from(
      original
        .toString()
        .replace('title: Synthetic privacy 2020-01-01', 'title: !!str Tagged'),
    ),
    Buffer.from(
      original
        .toString()
        .replace(
          'title: Synthetic privacy 2020-01-01',
          'title: Ok\nunknown: value',
        ),
    ),
    Buffer.from(original.toString().replace('## Scope', '# Wrong H1')),
    Buffer.from(`${original.toString().split('\n---\n')[0]}\n---\n`),
    Buffer.alloc(2 * 1024 * 1024 + 1, 'a'),
  ])(
    'rejects malformed, ambiguous, mismatched and oversized sources',
    (bytes) => expect(() => parse(bytes)).toThrow(),
  );
  it('rejects duplicate policy slugs and registry schema downgrades', () => {
    expect(() => validateRegistry({ ...registry, schemaVersion: 0 })).toThrow();
    expect(() =>
      validateRegistry({
        ...registry,
        policies: [...registry.policies, registry.policies[0]],
      }),
    ).toThrow();
  });
  it('automatically discovers new files and computes hashes without a manifest or registration', async () => {
    const { directory, source } = await content();
    expect((await source.load()).revisions).toEqual([]);
    await writeFile(join(directory, 'privacy/2020-01-01.md'), original);
    expect((await source.load()).revisions[0].sha256).toBe(
      parse(original).sha256,
    );
    await writeFile(
      join(directory, 'privacy/2021-01-01.md'),
      syntheticMarkdown('privacy', '2021-01-01'),
    );
    expect(
      createCatalog(await source.load()).policies.privacy.map(
        (entry) => entry.revision,
      ),
    ).toEqual(['2021-01-01', '2020-01-01']);
    const changed = Buffer.from(`${original}Changed draft.\n`);
    await writeFile(join(directory, 'privacy/2020-01-01.md'), changed);
    expect((await source.load()).revisions[0].sha256).toBe(
      createHash('sha256').update(changed).digest('hex'),
    );
  });
  it('fails closed on missing manifests and symlink replacement', async () => {
    const { directory, source } = await content();
    const path = join(directory, 'privacy/2020-01-01.md');
    await writeFile(path, original);
    await rm(path);
    await symlink(join(directory, 'policies.json'), path);
    await expect(source.load()).rejects.toThrow('Unexpected policy source');
    await rm(join(directory, 'policies.json'));
    await expect(source.load()).rejects.toThrow();
  });
  it('rejects undeclared folders, unexpected files and symlink directories', async () => {
    const { directory, source } = await content();
    await writeFile(join(directory, 'unexpected.json'), '{}');
    await expect(source.load()).rejects.toThrow(
      'Unexpected legal source entry',
    );
    await rm(join(directory, 'unexpected.json'));
    await mkdir(join(directory, 'unknown'));
    await expect(source.load()).rejects.toThrow(
      'Unexpected legal source entry',
    );
    await rm(join(directory, 'unknown'), { recursive: true });
    await symlink(join(directory, 'privacy'), join(directory, 'terms'));
    await expect(source.load()).rejects.toThrow(
      'Unexpected legal source entry',
    );
  });
});

describe('generated HTML, Markdown and catalog', () => {
  it('renders the shared website footer on every default and dated policy page', () => {
    const artifacts = generateArtifacts(fixtureSources(), template);
    for (const [path, bytes] of artifacts) {
      if (!path.endsWith('.html')) continue;
      const html = String(bytes);
      expect(html).toContain(createFooterMarkup({ showCta: false }));
      expect(html).not.toContain('new-footer-main');
      expect(html).not.toContain('new-footer-cta');
      expect(html).not.toContain('legal-types');
      expect(html.match(/<footer\b/g)).toHaveLength(1);
      expect(html).not.toContain('legal-footer');
    }
  });
  it('exposes per-revision consent flags as JSON booleans, defaulting omitted fields to false', () => {
    const sources = fixtureSources(['2019-01-01']);
    for (const [revision, requiresConsent] of [
      ['2020-01-01', true],
      ['2021-01-01', false],
    ] as const)
      sources.revisions.push(
        parseSource(
          syntheticMarkdown('privacy', revision, requiresConsent),
          `privacy/${revision}.md`,
          registry,
        ),
      );
    const artifacts = generateArtifacts(sources, template);
    const catalog = JSON.parse(String(artifacts.get('legal/policies.json')));
    expect(
      catalog.policies.privacy.map(
        (entry: { revision: string; requiresConsent: boolean }) => [
          entry.revision,
          entry.requiresConsent,
        ],
      ),
    ).toEqual([
      ['2021-01-01', false],
      ['2020-01-01', true],
      ['2019-01-01', false],
    ]);
  });
  it('computes catalog hashes from the complete source, including consent metadata', async () => {
    const { directory, source } = await content();
    const path = join(directory, 'privacy/2020-01-01.md');
    const bytes = syntheticMarkdown('privacy', '2020-01-01', true);
    await writeFile(path, bytes);
    expect(
      createCatalog(await source.load()).policies.privacy[0].requiresConsent,
    ).toBe(true);
    await writeFile(
      path,
      bytes
        .toString()
        .replace('requiresConsent: true', 'requiresConsent: false'),
    );
    const updated = createCatalog(await source.load()).policies.privacy[0];
    expect(updated.requiresConsent).toBe(false);
    expect(updated.sha256).not.toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
  it('publishes sorted fixed URLs, original bytes, complete static articles and fallbacks', () => {
    const sources = fixtureSources();
    const artifacts = generateArtifacts(sources, template);
    const catalog = JSON.parse(String(artifacts.get('legal/policies.json')));
    expect(
      catalog.policies.privacy.map(
        (entry: { revision: string }) => entry.revision,
      ),
    ).toEqual(['2099-01-01', '2021-01-01', '2020-01-01', '2019-01-01']);
    for (const revision of sources.revisions) {
      const path = `legal/privacy/${revision.revision}`;
      expect(artifacts.get(`${path}.md`)).toBe(revision.bytes);
      expect(
        createHash('sha256')
          .update(artifacts.get(`${path}.md`) ?? '')
          .digest('hex'),
      ).toBe(revision.sha256);
      const html = String(artifacts.get(`${path}/index.html`));
      expect(html).toContain(`data-revision="${revision.revision}"`);
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
      expect(html).toContain(`href="https://klex.bot/${path}"`);
      expect(html).toContain('section-scope-2');
      expect(html).toContain('Download original Markdown');
      expect(html).not.toMatch(/posthog|telemetry/i);
    }
    expect(String(artifacts.get('legal/privacy/index.html'))).not.toContain(
      'data-legal-article',
    );
    expect(String(artifacts.get('legal/terms/index.html'))).toContain(
      'not yet available',
    );
    expect(String(artifacts.get('legal/dpa/index.html'))).toContain(
      'Data Processing Agreement',
    );
    expect(catalog.policies.terms).toEqual([]);
  });
  it('handles slash/no-slash routes and rejects missing legal paths instead of SPA fallback', () => {
    const artifacts = generateArtifacts(fixtureSources(), template);
    for (const path of [
      '/legal/privacy',
      '/legal/privacy/',
      '/legal/privacy/2020-01-01',
      '/legal/privacy/2020-01-01/',
    ])
      expect(resolveLegalRequest(path, artifacts)).toMatch(/index.html$/);
    expect(resolveLegalRequest('/legal/privacy/2020-01-01.md', artifacts)).toBe(
      'legal/privacy/2020-01-01.md',
    );
    for (const path of [
      '/legal/privacy/nope',
      '/legal/privacy/2020-01-02',
      '/legal/missing',
      '/legal',
      '/legal/policies.json/extra',
    ])
      expect(resolveLegalRequest(path, artifacts)).toBeUndefined();
  });
  it('escapes HTML, suppresses images/executable links and provides stable unique anchors', () => {
    const html = renderMarkdown(
      '## Scope\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![bad](https://evil.invalid/pixel)\n\n## Scope\n',
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script|<img|href="javascript:/);
    expect(html).toContain('id="section-scope"');
    expect(html).toContain('id="section-scope-2"');
    expect(() => renderMarkdown('# Duplicate page title')).toThrow('H2');
  });
});
