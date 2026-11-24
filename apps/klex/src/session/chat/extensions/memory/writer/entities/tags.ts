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
 * nested), sorted so children follow their parent.
 */
export function knownTags(entities: readonly MemoryEntity[]): KnownTag[] {
  const counts = new Map<string, number>(DEFAULT_TAGS.map((tag) => [tag, 0]));
  for (const entity of entities)
    for (const tag of new Set(entity.frontmatter.Tags))
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
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
