import {
  type BlockField,
  field as blockField,
  dataFields,
  type FieldPolicy,
  renderDataBlock,
} from '@/session/chat/utils/history-view';

import type { MemorySnapshot } from './types';

export { inline } from '@/session/chat/utils/history-view';
export const MEMORY_FIELD_POLICY = {
  defaultSource: 'bot',
  sources: {
    entity: 'trusted',
    skill: 'trusted',
    section: 'trusted',
    additionalSections: 'trusted',
    entityType: 'trusted',
    tags: 'trusted',
    linkedIdentities: 'trusted',
    loadOn: 'trusted',
    replacement: 'trusted',
    removed: 'trusted',
  },
} as const satisfies FieldPolicy;

/** Shared presentation only; persisted snapshots deliberately stay unchanged. */
export function formatMemory(
  snapshot: MemorySnapshot,
  filename: string,
  replacement = false,
  extra: readonly BlockField[] = [],
): string {
  if (snapshot.kind === 'skill' || snapshot.kind === 'skill-reference')
    return formatSkill(snapshot, {
      replacement,
      reference:
        snapshot.kind === 'skill-reference' ? snapshot.section : undefined,
      extra,
    });
  return renderDataBlock({
    type: snapshot.kind === 'detail' ? 'memory-detail' : 'memory',
    fields: [
      ...dataFields(
        {
          entity: filename
            .replace(/^extensions\/io\.stagewise\/memory\/entities\//, '')
            .replace(/\.md$/, ''),
          section: snapshot.section || undefined,
          replacement: replacement || undefined,
          entityType: snapshot.entityType || undefined,
          tags: snapshot.tags?.length ? snapshot.tags : undefined,
          description: snapshot.description || undefined,
          linkedIdentities: snapshot.linkedIdentities?.length
            ? snapshot.linkedIdentities
            : undefined,
          additionalSections: snapshot.sections.length
            ? snapshot.sections
            : undefined,
        },
        MEMORY_FIELD_POLICY,
      ),
      ...dataFields(
        Object.fromEntries(
          Object.entries(snapshot.relationships ?? {}).map(([key, targets]) => [
            key,
            targets.map((target) => target.replace(/(?:\/SKILL)?\.md$/, '')),
          ]),
        ),
        'trusted',
      ),
      ...(snapshot.loadOn?.length
        ? [blockField('loadOn', snapshot.loadOn, 'trusted')]
        : []),
      ...extra,
      ...dataFields({ facts: snapshot.body }, MEMORY_FIELD_POLICY),
    ],
  });
}

export function skillBody(
  snapshot: Pick<MemorySnapshot, 'body' | 'references'>,
  referenceTool: 'loadSkill' | 'readSkill' = 'loadSkill',
): string {
  return (
    snapshot.body +
    (snapshot.references?.length
      ? `\n\nReferences (${referenceTool} with reference): ${snapshot.references.join(', ')}`
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
    referenceTool?: 'loadSkill' | 'readSkill';
    replacement?: boolean;
    extra?: readonly BlockField[];
  } = {},
): string {
  return renderDataBlock({
    type: options.reference === undefined ? 'skill' : 'skill-reference',
    fields: [
      blockField('skill', snapshot.title ?? '', 'trusted'),
      ...(options.reference === undefined
        ? []
        : [blockField('reference', options.reference, 'trusted')]),
      ...(options.replacement
        ? [blockField('replacement', true, 'trusted')]
        : []),
      ...(snapshot.description
        ? [blockField('description', snapshot.description, 'bot')]
        : []),
      ...(options.extra ?? []),
      blockField('content', skillBody(snapshot, options.referenceTool), 'bot'),
    ],
  });
}
