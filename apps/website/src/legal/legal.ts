export interface Revision {
  revision: string;
  effectiveDate: string;
  requiresConsent: boolean;
  url: string;
  markdownUrl: string;
  sha256: string;
}

export interface Catalog {
  schemaVersion: 1;
  policies: Record<string, Revision[]>;
}

export const PUBLIC_ORIGIN = 'https://klex.bot';
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_RENDERED_BYTES = 16 * 1024 * 1024;
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected an object',
  );
  return value as Record<string, unknown>;
}

export function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  assert(
    required.every((key) => Object.hasOwn(value, key)),
    'Missing required field',
  );
  assert(
    Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    'Unknown field',
  );
}

export function date(value: unknown): string {
  assert(
    typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value),
    'Expected YYYY-MM-DD',
  );
  const parsed = new Date(`${value}T00:00:00.000Z`);
  assert(
    Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value,
    'Invalid calendar date',
  );
  return value;
}

export function slug(value: unknown): string {
  assert(
    typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value),
    'Invalid policy slug',
  );
  assert(
    !['constructor', 'prototype', 'policies', 'assets', 'index'].includes(
      value,
    ),
    'Reserved policy slug',
  );
  return value;
}

export function origin(value: string): string {
  const url = new URL(value);
  assert(
    ['https:', 'http:'].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password,
    'Expected a bare HTTP(S) origin',
  );
  assert(
    url.protocol === 'https:' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'HTTP is only permitted for local previews',
  );
  return url.origin;
}

export function revisionPath(policy: string, revision: string): string {
  return `/legal/${slug(policy)}/${date(revision)}`;
}

export function safeLink(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject ASCII controls, whitespace and backslashes in browser URLs.
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith('//'))
    return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(value))
    return /^(https?:|mailto:)/i.test(value);
  return true;
}

export function validateCatalog(
  value: unknown,
  expectedOrigin = PUBLIC_ORIGIN,
): Catalog {
  origin(expectedOrigin);
  const root = object(value);
  keys(root, ['schemaVersion', 'policies']);
  assert(root.schemaVersion === 1, 'Unsupported legal catalog schema');
  const policies = object(root.policies);
  const result: Catalog = { schemaVersion: 1, policies: Object.create(null) };
  for (const [policy, values] of Object.entries(policies)) {
    slug(policy);
    assert(
      Array.isArray(values) && values.length <= 10000,
      'Invalid revision list',
    );
    let previous = '9999-12-32';
    result.policies[policy] = values.map((value) => {
      const record = object(value);
      keys(record, [
        'revision',
        'effectiveDate',
        'requiresConsent',
        'url',
        'markdownUrl',
        'sha256',
      ]);
      const revision = date(record.revision);
      const effectiveDate = date(record.effectiveDate);
      assert(
        revision === effectiveDate && effectiveDate < previous,
        'Revisions must have unique dates in newest-first order',
      );
      previous = effectiveDate;
      const path = revisionPath(policy, revision);
      assert(
        record.url === `${expectedOrigin}${path}` &&
          record.markdownUrl === `${expectedOrigin}${path}.md`,
        'Unexpected legal URL',
      );
      assert(
        typeof record.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(record.sha256),
        'Invalid SHA-256',
      );
      assert(
        typeof record.requiresConsent === 'boolean',
        'requiresConsent must be a boolean',
      );
      return {
        revision,
        effectiveDate,
        requiresConsent: record.requiresConsent,
        url: record.url as string,
        markdownUrl: record.markdownUrl as string,
        sha256: record.sha256,
      };
    });
  }
  return result;
}

export function selectEffective(
  revisions: Revision[],
  now: Date,
): Revision | undefined {
  const today = now.toISOString().slice(0, 10);
  return revisions.find((record) => record.effectiveDate <= today);
}

export function revisionState(
  revisions: Revision[],
  displayed: Revision,
  now: Date,
) {
  const current = selectEffective(revisions, now);
  const index = revisions.findIndex(
    (record) => record.revision === displayed.revision,
  );
  assert(index >= 0, 'Displayed revision missing from catalog');
  const status =
    displayed.effectiveDate > now.toISOString().slice(0, 10)
      ? 'upcoming'
      : current?.revision === displayed.revision
        ? 'current'
        : 'historical';
  return {
    status,
    current,
    earlier:
      status === 'current'
        ? revisions.slice(index + 1, index + 2)
        : revisions.slice(index + 1),
  };
}

export function boundaryDelay(revisions: Revision[], now: Date): number {
  const next = revisions
    .map((record) => Date.parse(`${record.effectiveDate}T00:00:00Z`))
    .filter((time) => time > now.getTime());
  return Math.max(
    1,
    Math.min(86400000, ...next.map((time) => time - now.getTime())),
  );
}
