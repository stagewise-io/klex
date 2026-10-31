import { MAX_PROMPT_LIST_CHARACTERS, type Skill } from '@/skills';

import systemPromptPart from './system-prompt-part.md';

const OVERFLOW_RESERVE_CHARACTERS = Math.floor(MAX_PROMPT_LIST_CHARACTERS / 10);

type ListedSkill = Pick<
  Skill,
  'id' | 'namespace' | 'name' | 'description' | 'lastReadAt' | 'updatedAt'
>;

/**
 * The main-session skill list: intro, then `- namespace/name: description`,
 * capped at `MAX_PROMPT_LIST_CHARACTERS`. Namespaces take turns, each in
 * most-recently-used order, so one large namespace cannot crowd out the
 * others; a namespace that runs out frees its share. When not all
 * descriptions fit, a tenth of the cap is reserved for an ids-only row, so
 * skills past the cap stay discoverable without exceeding it.
 */
export function renderSkillList(skills: readonly ListedSkill[]): string {
  if (skills.length === 0) return '';
  const ordered = fairOrder(skills);
  let { lines, overflow, length } = describe(
    ordered,
    MAX_PROMPT_LIST_CHARACTERS,
  );
  if (overflow.length > 0) {
    ({ lines, overflow, length } = describe(
      ordered,
      MAX_PROMPT_LIST_CHARACTERS - OVERFLOW_RESERVE_CHARACTERS,
    ));
    let row = '- More skills (read one to see when it applies): ';
    let named = 0;
    for (const id of overflow) {
      const next = named === 0 ? `${row}${id}` : `${row}, ${id}`;
      if (length + next.length + 1 > MAX_PROMPT_LIST_CHARACTERS) break;
      row = next;
      named += 1;
    }
    if (named > 0) lines.push(row);
  }
  return `${systemPromptPart.trimEnd()}\n\n${lines.join('\n')}`;
}

/** Round-robin over namespaces (sorted), each most recently used first. */
export function fairOrder<T extends ListedSkill>(skills: readonly T[]): T[] {
  const byNamespace = new Map<string, T[]>();
  for (const skill of skills) {
    const group = byNamespace.get(skill.namespace);
    if (group) group.push(skill);
    else byNamespace.set(skill.namespace, [skill]);
  }
  const groups = [...byNamespace.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) =>
      group.sort(
        (left, right) =>
          recency(right) - recency(left) || left.name.localeCompare(right.name),
      ),
    );
  const ordered: T[] = [];
  for (let index = 0; ordered.length < skills.length; index++) {
    for (const group of groups) {
      const skill = group[index];
      if (skill) ordered.push(skill);
    }
  }
  return ordered;
}

function recency(skill: ListedSkill): number {
  const value = Date.parse(skill.lastReadAt ?? skill.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/** Description lines in order until `budget`; the rest are overflow ids. */
function describe(
  ordered: readonly ListedSkill[],
  budget: number,
): { lines: string[]; overflow: string[]; length: number } {
  const lines: string[] = [];
  const overflow: string[] = [];
  let length = 0;
  for (const skill of ordered) {
    const line = `- ${skill.id}: ${skill.description.replace(/\s+/g, ' ')}`;
    if (overflow.length === 0 && length + line.length + 1 <= budget) {
      lines.push(line);
      length += line.length + 1;
    } else {
      overflow.push(skill.id);
    }
  }
  return { lines, overflow, length };
}
