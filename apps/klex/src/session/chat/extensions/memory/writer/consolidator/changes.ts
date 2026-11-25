import type { Skill } from '@/skills';

import type { MemoryEntity } from '../entities';
import { entityReadResult, skillReadResult } from '../tools';
import type { ConsolidatorStateData } from './state';

export const CHANGE_BUDGET = 60_000;
export interface ChangedItem {
  kind: 'entity' | 'skill';
  id: string;
  writtenAt: string;
  text: string;
}

/** Timestamp ordering plus the persisted skip list handles equal-time boundaries. */
export function collectChanges(
  entities: readonly MemoryEntity[],
  skills: readonly Skill[],
  state: ConsolidatorStateData,
  budget = CHANGE_BUDGET,
): { items: ChangedItem[]; overflow: boolean; cutoff: string | null } {
  const candidates: ChangedItem[] = [
    ...entities.map((entity) => ({
      kind: 'entity' as const,
      id: entity.id,
      writtenAt: entity.frontmatter.LastUpdatedAt,
      text: entityReadResult(entity, Object.keys(entity.sections)),
    })),
    ...skills
      .filter((skill) => skill.namespace === 'learning')
      .map((skill) => ({
        kind: 'skill' as const,
        id: skill.id,
        writtenAt: skill.updatedAt,
        text: skillReadResult(skill),
      })),
  ]
    .filter(
      (item) =>
        (!state.lastRunAt || item.writtenAt >= state.lastRunAt) &&
        !state.written.some(
          (written) =>
            written.kind === item.kind &&
            written.id === item.id &&
            written.writtenAt >= item.writtenAt,
        ),
    )
    .sort(
      (a, b) =>
        a.writtenAt.localeCompare(b.writtenAt) ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );
  const items: ChangedItem[] = [];
  let size = 0;
  for (const candidate of candidates) {
    // Oversized documents are discoverable, never silently skipped. The child
    // reads their full content (and references) through its ordinary read tools.
    const text =
      candidate.text.length + 1 > budget
        ? JSON.stringify({
            kind: candidate.kind,
            id: candidate.id,
            omitted:
              'Oversized document; read with readEntity/readSkill before curating.',
          })
        : candidate.text;
    if (size + text.length + 1 > budget) break;
    items.push({ ...candidate, text });
    size += text.length + 1;
  }
  return {
    items,
    overflow: items.length < candidates.length,
    cutoff: items.at(-1)?.writtenAt ?? null,
  };
}
