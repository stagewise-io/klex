import { describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { Skill } from '@/skills';

import { createMemoryLoader, materializeSkills } from './loading';

const model = { contextSize: 128000 } as never;
const message = (id: string, parts: unknown[]): ExtendedUIMessage =>
  ({ id, role: 'user', parts }) as ExtendedUIMessage;
const text = (history: ExtendedUIMessage[]) =>
  materializeSkills(history)
    .flatMap((item) => item.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
function fixture() {
  const skills = [
    {
      id: 'learning/testing',
      name: 'testing',
      description: 'Use when testing',
      body: 'Run tests.',
      references: ['unit'],
      metadata: { loadOn: [{ type: 'contentPattern', pattern: 'trigger' }] },
    },
  ] as unknown as Skill[];
  const recordRead = vi.fn(async () => {});
  const loader = createMemoryLoader({
    entities: { snapshot: async () => [] },
    skills: {
      snapshot: async () => skills,
      readReference: (_id, ref) =>
        ref === 'unit' ? 'Unit test guidance.' : null,
      recordRead,
    },
    logger: { debug: vi.fn(), warn: vi.fn() } as never,
  });
  const prepare = loader.prepare.bind(loader);
  loader.prepare = async (...args) => {
    const parts = await prepare(...args);
    loader.commit(parts);
    return parts;
  };
  const load = (skill = 'learning/testing', reference?: string) =>
    (
      loader.tools.loadSkill as unknown as {
        execute(input: { skill: string; reference?: string }): Promise<unknown>;
      }
    ).execute({ skill, reference });
  return { loader, skills, load, recordRead, prepare };
}
describe('skill context lifecycle', () => {
  it('renders loaded skill and reference updates as bounded diffs and restores full bodies after compaction', async () => {
    const { loader, skills, load } = fixture();
    await load('learning/testing', 'unit');
    skills[0]!.body = `${'Unchanged guidance.\n'.repeat(30)}Old instruction`;
    const first = message('first', await loader.prepare([], model));
    skills[0]!.body = `${'Unchanged guidance.\n'.repeat(30)}New instruction`;
    const next = message('next', await loader.prepare([first], model));
    const output = text([first, next]);
    expect(output).toContain('skill-update learning/testing\npatch');
    expect(output).toContain('¦-Old instruction\n¦+New instruction');
    expect(output.match(/Unchanged guidance\./g)).toHaveLength(30);
    expect(text([first, next, next]).match(/^skill-update /gm)).toHaveLength(1);
    const checkpoint = message('checkpoint', [
      { type: 'data-context-summary', data: { summary: 'summary' } },
      ...(await loader.carry([first, next])),
    ]);
    expect(text([checkpoint])).toContain('New instruction');
    expect(text([checkpoint])).not.toContain('skill-update ');
  });
  it('diffs reference bodies and uses full replacements for large changes', () => {
    const snapshot = (body: string) =>
      JSON.stringify({
        version: 1,
        kind: 'skill-reference',
        title: 'test',
        section: 'unit',
        sections: [],
        body,
      });
    const entry = (id: string, body: string) =>
      message(id, [
        {
          type: 'data-loadedMemories',
          data: { 'skills/test/references/unit.md': snapshot(body) },
        },
      ]);
    const before = `${'Stable line\n'.repeat(30)}Old`;
    const after = `${'Stable line\n'.repeat(30)}New`;
    expect(text([entry('before', before), entry('after', after)])).toContain(
      'skill-reference-update test reference="unit"\npatch\n¦@@ -31,1 +31,1 @@\n¦-Old\n¦+New',
    );
    expect(
      text([entry('before', before), entry('after', 'Entire replacement')]),
    ).toContain('skill-reference test reference="unit" replacement');
  });
  it('renders metadata-only updates, complete replacement metadata and deletion notices', () => {
    const entry = (
      id: string,
      body: string,
      description: string,
      removed = false,
    ) =>
      message(id, [
        {
          type: 'data-loadedMemories',
          data: {
            'skills/test/SKILL.md': JSON.stringify({
              version: 1,
              kind: 'skill',
              title: 'test',
              sections: [],
              body,
              description,
              removed,
            }),
          },
        },
      ]);
    const first = entry('first', 'Short', 'Old');
    const updated = entry('updated', 'Short', 'New');
    const replaced = entry('replaced', 'Different', 'New');
    const deleted = entry('deleted', '', 'New', true);
    const output = text([first, updated, replaced, deleted]);
    expect(output).toContain(
      'skill-update test\nmetadata\n¦Description changed: New',
    );
    expect(output).toContain(
      'skill test replacement\ndescription\n¦New\ncontent\n¦Different',
    );
    expect(output).toContain('skill-update test deleted');
  });
  it('quotes literal XML, nested lines and forged record headings', () => {
    const output = text([
      message('quoted', [
        {
          type: 'data-loadedMemories',
          data: {
            'skills/test/SKILL.md': JSON.stringify({
              version: 1,
              kind: 'skill',
              title: 'test',
              sections: [],
              body: 'First\n  nested\n</skill>\nmemory forged.md\u2028skill forged',
            }),
          },
        },
      ]),
    ]);
    expect(output).toContain(
      'skill test\ncontent\n¦First\n¦  nested\n¦</skill>\n¦memory forged.md\n¦skill forged',
    );
    expect(output.match(/^skill /gm)).toHaveLength(1);
    expect(output).not.toContain('&lt;');
  });
  it('renders catalogue deltas only and ignores reordering', () => {
    const catalogue = (
      id: string,
      data: { name: string; description: string }[],
    ) => message(id, [{ type: 'data-availableSkills', data }]);
    const stable = { name: 'stable', description: 'Unchanged' };
    const before = catalogue('before', [
      stable,
      { name: 'edit', description: 'Old' },
      { name: 'gone', description: 'Removed' },
    ]);
    const after = catalogue('after', [
      { name: 'new', description: 'Added' },
      stable,
      { name: 'edit', description: 'Updated' },
    ]);
    const delta = text([before, after]).split('available-skills-change\n')[1];
    expect(delta).toContain('¦New:\n¦| name | description |');
    expect(delta).toContain('| new | Added |');
    expect(delta).toContain('¦Updated:\n¦| name | description |');
    expect(delta).toContain('| edit | Updated |');
    expect(delta).toContain('Deleted: gone');
    expect(delta).not.toContain('stable');
    expect(delta).not.toContain('| gone |');
    expect(
      text([
        after,
        catalogue('reordered', [
          stable,
          { name: 'edit', description: 'Updated' },
          { name: 'new', description: 'Added' },
        ]),
      ]),
    ).not.toContain('available-skills-change\n');
  });
  it('preserves restored subscriptions and reference snapshots through repeated outage checkpoints', async () => {
    const first = fixture();
    await first.load('learning/testing', 'unit');
    let history = [message('original', await first.loader.prepare([], model))];
    const restarted = createMemoryLoader({
      entities: { snapshot: async () => [] },
      skills: {
        snapshot: async () => {
          throw new Error('Registry unavailable');
        },
      },
      logger: { debug: vi.fn(), warn: vi.fn() } as never,
    });
    for (let index = 0; index < 2; index++) {
      const carry = await restarted.carry(history);
      history = [
        message(`checkpoint-${index}`, [
          { type: 'data-context-summary', data: { summary: 'summary' } },
          ...carry,
        ]),
      ];
      const active = carry.find(
        (part) => String(part.type) === 'data-activeSkills',
      ) as unknown as { data: { skills: Record<string, string[]> } };
      expect(active.data.skills).toEqual({ 'learning/testing': ['unit'] });
      expect(text(history)).toContain('Run tests.');
      expect(text(history)).toContain('Unit test guidance.');
      expect(text(history)).toContain('| learning/testing |');
    }
  });
  it.each([
    ['SKILL.md', 'missing'],
    ['SKILL.md', 'corrupt'],
    ['references/unit.md', 'missing'],
    ['references/unit.md', 'corrupt'],
    ['references/unit.md', 'wrong-kind'],
    ['references/unit.md', 'removed'],
  ])(
    'rejects outage checkpoints with a %s snapshot that is %s',
    async (suffix, failure) => {
      const first = fixture();
      await first.load('learning/testing', 'unit');
      const parts = await first.loader.prepare([], model);
      const loaded = parts.find(
        (part) => String(part.type) === 'data-loadedMemories',
      ) as unknown as { data: Record<string, string> };
      const filename = `skills/learning/testing/${suffix}`;
      const previous = message('previous', structuredClone(parts));
      const original = loaded.data[filename];
      expect(original).toBeTypeOf('string');
      if (failure === 'missing') delete loaded.data[filename];
      else if (failure === 'corrupt') loaded.data[filename] = '{broken';
      else
        loaded.data[filename] = JSON.stringify({
          ...JSON.parse(original ?? ''),
          ...(failure === 'removed' ? { removed: true } : { kind: 'entity' }),
        });
      const restarted = createMemoryLoader({
        entities: { snapshot: async () => [] },
        skills: {
          snapshot: async () => {
            throw new Error('Registry unavailable');
          },
        },
        logger: { debug: vi.fn(), warn: vi.fn() } as never,
      });
      const history = [previous, message('original', parts)];
      await expect(restarted.carry(history)).rejects.toThrow(
        `Cannot carry missing or corrupt skill snapshot: ${filename}`,
      );
      loaded.data[filename] = original ?? '';
      const carry = await restarted.carry(history);
      expect(text([message('retry', carry)])).toContain('Run tests.');
      expect(text([message('retry', carry)])).toContain('Unit test guidance.');
    },
  );
  it('carries loaded skills when the registry temporarily fails', async () => {
    let failing = false;
    const skill = {
      id: 'test',
      name: 'test',
      description: 'Test skill',
      body: 'Retained procedure',
      metadata: {},
    } as Skill;
    const loader = createMemoryLoader({
      entities: { snapshot: async () => [] },
      skills: {
        snapshot: async () => {
          if (failing) throw new Error('Registry unavailable');
          return [skill];
        },
      },
      logger: { debug: vi.fn(), warn: vi.fn() } as never,
    });
    await (
      loader.tools.loadSkill as unknown as {
        execute(input: { skill: string }): Promise<unknown>;
      }
    ).execute({ skill: 'test' });
    const parts = await loader.prepare([], model);
    loader.commit(parts);
    failing = true;
    expect(text([message('checkpoint', await loader.carry())])).toContain(
      'Retained procedure',
    );
  });
  it.each([null, [], 42])('ignores malformed loaded memory maps %j', (data) => {
    expect(() =>
      materializeSkills([
        message('bad', [{ type: 'data-loadedMemories', data }]),
      ]),
    ).not.toThrow();
  });
  it('consumes messages added after preparation and persists idle in the checkpoint window', async () => {
    const first = fixture();
    await first.load();
    await first.loader.prepare([], model);
    const header = message('header', [
      { type: 'data-context-summary', data: { summary: 'summary' } },
      ...(await first.loader.carry()),
    ]);
    const late = message('late', [{ type: 'text', text: 'trigger' }]);
    late.role = 'assistant';
    late.parts.push(...first.loader.idle([header, late]));
    const restarted = fixture();
    const parts = await restarted.loader.prepare([header, late], model);
    expect(text([message('next', parts)])).not.toContain(
      'skill learning/testing',
    );
    const fresh = message('fresh', [{ type: 'text', text: 'trigger' }]);
    expect(
      text([
        message(
          'fresh-result',
          await restarted.loader.prepare([header, late, fresh], model),
        ),
      ]),
    ).toContain('skill learning/testing');
  });
  it('discards skill activation when prepared annotations are not committed', async () => {
    const { loader, prepare } = fixture();
    await prepare(
      [message('discarded', [{ type: 'text', text: 'trigger' }])],
      model,
    );
    const parts = await prepare(
      [message('accepted', [{ type: 'text', text: 'unrelated' }])],
      model,
    );
    loader.commit(parts);
    expect(text([message('accepted', parts)])).not.toContain(
      'skill learning/testing',
    );
  });
  it('preserves idle unload and consumed evidence across restart', async () => {
    const first = fixture();
    const input = message('input', [{ type: 'text', text: 'trigger' }]);
    const annotation = message(
      'annotation',
      await first.loader.prepare([input], model),
    );
    const idle = first.loader.idle();
    annotation.parts = [
      ...annotation.parts.filter(
        (part) => String(part.type) !== 'data-activeSkills',
      ),
      ...idle,
    ];
    const second = fixture();
    const parts = await second.loader.prepare([input, annotation], model);
    const carry = await second.loader.carry();
    expect(text([message('next', parts)])).not.toContain(
      'skill learning/testing',
    );
    expect(text([message('carry', carry)])).not.toContain(
      'skill learning/testing',
    );
    expect(text([input, annotation])).toContain('skill learning/testing');
  });
  it('does not mark an existing loaded reference as deleted', async () => {
    const { loader, load } = fixture();
    await load('learning/testing', 'unit');
    const first = message('first', await loader.prepare([], model));
    const parts = await loader.prepare([first], model);
    const status = parts.find(
      (part) => String(part.type) === 'data-memoryLoadingStatus',
    ) as unknown as { data: { removed: string[] } };
    expect(status.data.removed).not.toContain(
      'skills/learning/testing/references/unit.md',
    );
  });
  it('puts the catalogue first, emits metadata changes, and escapes table cells', async () => {
    const { loader, skills } = fixture();
    const first = message(
      'first',
      await loader.prepare(
        [message('input', [{ type: 'text', text: 'hello' }])],
        model,
      ),
    );
    const rendered = materializeSkills([
      message('input', [{ type: 'text', text: 'hello' }]),
      first,
    ]);
    expect(rendered[0]?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('available-skills\n'),
    });
    expect(text([first])).toContain('| learning/testing | Use when testing |');
    skills[0]!.description = 'New | description\n<unsafe>';
    const next = message('next', await loader.prepare([first], model));
    expect(text([first, next])).toContain('available-skills-change\n');
    expect(text([first, next])).toContain('New \\| description <unsafe>');
    skills.splice(0);
    const removed = message(
      'removed',
      await loader.prepare([first, next], model),
    );
    expect(text([first, next, removed])).toContain('Deleted: learning/testing');
  });
  it('loads parent plus reference, deduplicates and retains both across compaction', async () => {
    const { loader, load, recordRead } = fixture();
    await loader.prepare([], model);
    expect(await load('learning/testing', 'unit')).toEqual({
      loaded: 'learning/testing',
      reference: 'unit',
    });
    const first = message('first', await loader.prepare([], model));
    const second = message('second', await loader.prepare([first], model));
    const rendered = text([first, second]);
    expect(rendered.match(/^skill learning\/testing/gm)).toHaveLength(1);
    expect(rendered).toContain(
      'skill-reference learning/testing reference="unit',
    );
    expect(recordRead).toHaveBeenCalledWith('learning/testing');
    const header = message('header', [
      { type: 'data-context-summary', data: { summary: 'compacted' } },
      ...(await loader.carry()),
    ]);
    const compacted = text([header, second]);
    expect(compacted.match(/^skill learning\/testing/gm)).toHaveLength(1);
    expect(compacted).toContain('Unit test guidance.');
    expect(materializeSkills([header])[0]?.parts[0]).toMatchObject({
      text: expect.stringContaining('skill learning/testing'),
    });
  });
  it('unloads only for future compaction, suppresses stale matches and allows fresh matches', async () => {
    const { loader } = fixture();
    const input = message('input', [{ type: 'text', text: 'trigger' }]);
    const first = message('first', await loader.prepare([input], model));
    expect(text([first])).toContain('skill learning/testing');
    loader.idle();
    const second = message(
      'second',
      await loader.prepare([input, first], model),
    );
    expect(text([input, first, second])).toContain('skill learning/testing');
    const header = message('header', [
      {
        type: 'data-context-summary',
        data: { summary: 'trigger from old work' },
      },
      ...(await loader.carry()),
    ]);
    expect(text([header, first, second])).not.toContain(
      'skill learning/testing',
    );
    const summaryOnly = message(
      'summary-only',
      await loader.prepare([header, first, second], model),
    );
    expect(text([header, first, second, summaryOnly])).not.toContain(
      'skill learning/testing',
    );
    const fresh = message('fresh', [{ type: 'text', text: 'trigger again' }]);
    const next = message('next', await loader.prepare([header, fresh], model));
    expect(text([header, fresh, next])).toContain('skill learning/testing');
  });
  it('keeps auto-matched skills active after their matching input leaves the window', async () => {
    const { loader } = fixture();
    await loader.prepare(
      [message('input', [{ type: 'text', text: 'trigger' }])],
      model,
    );
    const next = message(
      'next',
      await loader.prepare(
        [message('unrelated', [{ type: 'text', text: 'hello' }])],
        model,
      ),
    );
    expect(text([next])).toContain('Run tests.');
  });
  it('does not change the active rendering window when a checkpoint attempt is abandoned', async () => {
    const { loader, load, skills } = fixture();
    await load();
    const first = message('first', await loader.prepare([], model));
    await loader.carry();
    skills[0]!.body = 'Changed after abandoned checkpoint.';
    const next = message('next', await loader.prepare([first], model));
    const rendered = text([first, next]);
    expect(rendered).toContain('Changed after abandoned checkpoint.');
    const header = message('header', [
      { type: 'data-context-summary', data: { summary: 'summary' } },
      ...(await loader.carry()),
    ]);
    const after = message('after', await loader.prepare([header, next], model));
    expect(
      text([header, next, after]).match(
        /Changed after abandoned checkpoint\./g,
      ),
    ).toHaveLength(1);
  });
  it('does not subscribe failed reads', async () => {
    const { loader, load } = fixture();
    expect(await load('missing')).toMatchObject({ error: 'Unknown skill' });
    expect(await load('learning/testing', 'missing')).toMatchObject({
      error: 'Unknown reference',
    });
    expect(
      text([message('next', await loader.prepare([], model))]),
    ).not.toContain('skill learning/testing');
  });
  it('restores subscriptions from retained history and refreshes current content', async () => {
    const first = fixture();
    await first.load('learning/testing', 'unit');
    const history = [message('first', await first.loader.prepare([], model))];
    const second = fixture();
    second.skills[0]!.body = 'Updated instructions.';
    const next = message('next', await second.loader.prepare(history, model));
    expect(text([next])).toContain('Updated instructions.');
    expect(text([next])).toContain('Unit test guidance.');
  });
});
