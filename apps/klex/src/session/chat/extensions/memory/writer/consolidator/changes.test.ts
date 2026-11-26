import { describe, expect, it } from 'vitest';

import type { Skill } from '@/skills';

import type { MemoryEntity } from '../entities';
import { entityReadResult, skillReadResult } from '../tools';
import { collectChanges } from './changes';

const at = '2026-11-25T10:00:00.000Z';
const entity = (id: string, writtenAt = at): MemoryEntity => ({
  id,
  frontmatter: {
    LastUpdatedAt: writtenAt,
    CreatedAt: at,
    LastReadAt: null,
    TrustScore: 2,
    AuthorityScore: 5,
    FormatVersion: 7,
    Tags: [],
    LinkedIdentities: [],
    LoadOn: [],
    RelatedTo: [],
  },
  sections: {
    General: [{ text: 'Builds widgets', sources: [], history: [] }],
    Details: [{ text: 'Uses titanium', sources: [], history: [] }],
  },
});
const empty = { lastRunAt: null, written: [] };
describe('consolidator change cursor', () => {
  it('includes the full first baseline, oldest first, and only learned skills', () => {
    const skills: Skill[] = ['templates', 'learning'].map((namespace) => ({
      namespace,
      id: `${namespace}/deploy`,
      updatedAt: at,
      name: 'deploy',
      createdAt: at,
      lastReadAt: null,
      readCount: 0,
      createdTurn: 0,
      updatedTurn: 0,
      lastReadTurn: null,
      userEdited: false,
      description: 'Deploy safely',
      body: 'Run the deploy checks.',
      references: [],
      metadata: {},
    }));
    const result = collectChanges(
      [entity('Z'), entity('A', '2026-11-24T10:00:00.000Z')],
      skills,
      empty,
    );
    expect(result.items.map(({ id }) => id)).toEqual([
      'A',
      'Z',
      'learning/deploy',
    ]);
    expect(result.overflow).toBe(false);
    expect(result.items[0]?.text).toBe(
      entityReadResult(entity('A', '2026-11-24T10:00:00.000Z'), [
        'General',
        'Details',
      ]),
    );
    expect(result.items[0]?.text).toContain('Uses titanium');
    expect(result.items[0]?.text).toContain('revision');
    expect(result.items[2]?.text).toBe(skillReadResult(skills[1] as Skill));
    expect(result.items[0]?.text).toMatch(/^# memory\nentity: A/);
    expect(result.items[0]?.text).toContain('\n\n# memory-detail\nentity: A');
    expect(result.items[2]?.text).toMatch(/^# skill\nskill: learning\/deploy/);
    for (const item of result.items) {
      expect(item.text).not.toMatch(/^~ (?:# |~ )/m);
    }
  });
  it('resumes across equal-time budget boundaries without losing or repeating items', () => {
    const records = [entity('A'), entity('B'), entity('C')];
    const budget =
      entityReadResult(entity('A'), ['General', 'Details']).length + 1;
    const first = collectChanges(records, [], empty, budget);
    expect(first.items.map(({ id }) => id)).toEqual(['A']);
    expect(first.overflow).toBe(true);
    const second = collectChanges(
      records,
      [],
      {
        lastRunAt: first.cutoff,
        written: first.items.map(({ kind, id, writtenAt }) => ({
          kind,
          id,
          writtenAt,
        })),
      },
      budget,
    );
    expect(second.items.map(({ id }) => id)).toEqual(['B']);
  });
  it('skips its own edits, but includes later writer changes', () => {
    const state = {
      lastRunAt: at,
      written: [{ kind: 'entity' as const, id: 'A', writtenAt: at }],
    };
    expect(collectChanges([entity('A')], [], state).items).toEqual([]);
    expect(
      collectChanges([entity('A', '2026-11-25T10:01:00.000Z')], [], state)
        .items,
    ).toHaveLength(1);
  });
  it('stubs an exact-budget document and advances past it', () => {
    const record = entity('A');
    const budget = entityReadResult(
      record,
      Object.keys(record.sections),
    ).length;
    const result = collectChanges([record], [], empty, budget);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.text).toContain('Oversized document');
    expect(result.items[0]?.text).toMatch(
      /^# changed-document\nkind: entity\nid: A/,
    );
    expect(result.cutoff).toBe(at);
    expect(result.overflow).toBe(false);
    expect(
      collectChanges(
        [record, entity('B')],
        [],
        {
          lastRunAt: result.cutoff,
          written: result.items.map(({ kind, id, writtenAt }) => ({
            kind,
            id,
            writtenAt,
          })),
        },
        budget,
      ).items.map(({ id }) => id),
    ).toEqual(['B']);
  });
  it('lists oversized documents for tool reads rather than starving the cursor', () => {
    const record = entity('Huge');
    record.sections = {
      General: [{ text: 'x'.repeat(70_000), sources: [], history: [] }],
    };
    const result = collectChanges([record], [], empty);
    expect(result.items[0]?.text).toContain('Oversized document');
    expect(result.overflow).toBe(false);
  });
});
