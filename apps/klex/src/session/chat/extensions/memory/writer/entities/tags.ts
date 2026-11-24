import type { MemoryEntity } from './entities';

/**
 * Default ontology. Always offered to the writer, even when no entity uses a
 * tag yet. Plural, lowercase kebab-case; children nest with `/`.
 */
export const DEFAULT_TAGS: readonly string[] = [
  'people',
  'people/coworkers',
  'people/contacts',
  'organizations',
  'organizations/customers',
  'organizations/partners',
  'teams',
  'projects',
  'work-items',
  'work-items/tasks',
  'work-items/issues',
  'systems',
  'systems/components',
  'systems/integrations',
  'products',
  'processes',
  'documents',
  'documents/guides',
  'documents/policies',
  'events',
  'events/meetings',
];

export interface KnownTag {
  tag: string;
  /** Entities carrying exactly this tag. */
  count: number;
}

/**
 * Static per-session snapshot: defaults merged with every tag in use (flat and
 * nested), sorted so children follow their parent. Implied parents (e.g.
 * `project` for `project/stagewise-io`) are listed with their own count, so
 * the indented tree never hangs a child under an unrelated sibling.
 */
export function knownTags(entities: readonly MemoryEntity[]): KnownTag[] {
  const counts = new Map<string, number>(DEFAULT_TAGS.map((tag) => [tag, 0]));
  for (const entity of entities)
    for (const tag of new Set(entity.frontmatter.Tags))
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const tag of [...counts.keys()]) {
    const segments = tag.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join('/');
      if (!counts.has(parent)) counts.set(parent, 0);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => compareTagPaths(a.tag, b.tag));
}

/** Segment-wise, so `a/b` sorts directly after `a`, before sibling `a-b`. */
function compareTagPaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i] as string;
    const y = right[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/** One tag per line, indented by depth, with usage counts. */
export function renderKnownTags(tags: readonly KnownTag[]): string {
  return tags
    .map(
      ({ tag, count }) =>
        `${'  '.repeat(tag.split('/').length - 1)}${tag} (${count})`,
    )
    .join('\n');
}
