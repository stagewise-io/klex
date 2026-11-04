import {
  createCatalog,
  type LegalSources,
  parseSource,
  type Registry,
} from './node/index.ts';

export const template =
  '<!doctype html><html lang="en"><head><!-- legal:head --></head><body><!-- legal:body --></body></html>';
export const registry: Registry = {
  schemaVersion: 1,
  policies: [
    { slug: 'privacy', label: 'Privacy Policy' },
    { slug: 'terms', label: 'Terms of Service' },
    { slug: 'dpa', label: 'Data Processing Agreement' },
  ],
};
export function syntheticMarkdown(
  policy: string,
  revision: string,
  requiresConsent?: boolean,
): Buffer {
  return Buffer.from(
    `---\ntitle: Synthetic ${policy} ${revision}\nchangeSummary: Synthetic fixture only, not approved legal text.\n${requiresConsent === undefined ? '' : `requiresConsent: ${requiresConsent}\n`}---\n\n## Scope\n\nThis is a **synthetic test fixture**, not a legal policy. Read the [section](#section-scope) or [example](https://example.invalid).\n\n## Scope\n\n- One item\n- Another item\n\n| Field | Description |\n| --- | --- |\n| Fixture | Synthetic |\n`,
  );
}
export function fixtureSources(
  dates = ['2019-01-01', '2020-01-01', '2021-01-01', '2099-01-01'],
): LegalSources {
  const revisions = dates.map((revision) =>
    parseSource(
      syntheticMarkdown('privacy', revision),
      `privacy/${revision}.md`,
      registry,
    ),
  );
  return {
    registry,
    revisions,
  };
}
export function fixtureCatalog(dates?: string[]) {
  return createCatalog(fixtureSources(dates));
}
