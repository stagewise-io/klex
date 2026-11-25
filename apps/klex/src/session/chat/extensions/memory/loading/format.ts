import type { MemorySnapshot } from './types';

export const quote = (value: string): string =>
  value
    .split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/u)
    .map((line) => `¦${line}`)
    .join('\n');
export const inline = (value: string): string =>
  value.replace(/[\r\n\v\f\u0085\u2028\u2029]/gu, ' ');
export const labelString = (value: string): string =>
  JSON.stringify(value)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
export const field = (name: string, value: string): string =>
  `${name}\n${quote(value)}`;

/** Shared presentation only; persisted snapshots deliberately stay unchanged. */
export function formatMemory(
  snapshot: MemorySnapshot,
  filename: string,
  replacement = false,
  extra: readonly string[] = [],
): string {
  const linked = (snapshot.linkedIdentities ?? [])
    .map(
      (identity) =>
        `${inline(identity.server)}:\n${Object.entries(identity.match)
          .map(([key, value]) => `  ${inline(key)}: ${inline(value)}`)
          .join('\n')}`,
    )
    .join('\n');
  return [
    `${snapshot.kind === 'detail' ? 'memory-detail' : 'memory'} ${labelString(filename)}${snapshot.section ? ` section=${labelString(snapshot.section)}` : ''}${replacement ? ' replacement' : ''}`,
    ...(snapshot.entityType ? [field('entityType', snapshot.entityType)] : []),
    ...(snapshot.tags?.length ? [field('tags', snapshot.tags.join(','))] : []),
    ...(snapshot.description
      ? [field('description', snapshot.description)]
      : []),
    ...(linked ? [field('linkedIdentities', linked)] : []),
    ...(snapshot.sections.length
      ? [
          field(
            'additionalSections',
            snapshot.sections
              .map((section) => `- ${inline(section)}`)
              .join('\n'),
          ),
        ]
      : []),
    ...extra,
    field('facts', snapshot.body),
  ].join('\n');
}

export function skillBody(
  snapshot: Pick<MemorySnapshot, 'body' | 'references'>,
): string {
  return (
    snapshot.body +
    (snapshot.references?.length
      ? `\n\nReferences (loadSkill with reference): ${snapshot.references.join(', ')}`
      : '')
  );
}

export function formatSkill(
  snapshot: Pick<
    MemorySnapshot,
    'title' | 'description' | 'body' | 'references'
  >,
  options: {
    reference?: string;
    replacement?: boolean;
    extra?: readonly string[];
  } = {},
): string {
  return [
    `${options.reference === undefined ? 'skill' : 'skill-reference'} ${inline(snapshot.title)}${options.reference === undefined ? '' : ` reference=${JSON.stringify(options.reference)}`}${options.replacement ? ' replacement' : ''}`,
    ...(snapshot.description
      ? [field('description', snapshot.description)]
      : []),
    ...(options.extra ?? []),
    field('content', skillBody(snapshot)),
  ].join('\n');
}
