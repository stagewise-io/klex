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
    expect(text([message('next', parts)])).not.toContain('<skill name=');
    const fresh = message('fresh', [{ type: 'text', text: 'trigger' }]);
    expect(
      text([
        message(
          'fresh-result',
          await restarted.loader.prepare([header, late, fresh], model),
        ),
      ]),
    ).toContain('<skill name=');
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
    expect(text([message('accepted', parts)])).not.toContain('<skill name=');
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
    expect(text([message('next', parts)])).not.toContain('<skill name=');
    expect(text([message('carry', carry)])).not.toContain('<skill name=');
    expect(text([input, annotation])).toContain('<skill name=');
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
      text: expect.stringContaining('<available-skills>'),
    });
    expect(text([first])).toContain('| learning/testing | Use when testing |');
    skills[0]!.description = 'New | description\n<unsafe>';
    const next = message('next', await loader.prepare([first], model));
    expect(text([first, next])).toContain('<available-skills-change>');
    expect(text([first, next])).toContain(
      'New &#124; description &lt;unsafe&gt;',
    );
    skills.splice(0);
    const removed = message(
      'removed',
      await loader.prepare([first, next], model),
    );
    expect(text([first, next, removed])).toContain('Removed: learning/testing');
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
    expect(rendered.match(/<skill name=/g)).toHaveLength(1);
    expect(rendered).toContain(
      '<skill-reference name="learning/testing" reference="unit">',
    );
    expect(recordRead).toHaveBeenCalledWith('learning/testing');
    const header = message('header', [
      { type: 'data-context-summary', data: { summary: 'compacted' } },
      ...(await loader.carry()),
    ]);
    const compacted = text([header, second]);
    expect(compacted.match(/<skill name=/g)).toHaveLength(1);
    expect(compacted).toContain('Unit test guidance.');
    expect(materializeSkills([header])[0]?.parts[0]).toMatchObject({
      text: expect.stringContaining('<skill name='),
    });
  });
  it('unloads only for future compaction, suppresses stale matches and allows fresh matches', async () => {
    const { loader } = fixture();
    const input = message('input', [{ type: 'text', text: 'trigger' }]);
    const first = message('first', await loader.prepare([input], model));
    expect(text([first])).toContain('<skill name=');
    loader.idle();
    const second = message(
      'second',
      await loader.prepare([input, first], model),
    );
    expect(text([input, first, second])).toContain('<skill name=');
    const header = message('header', [
      {
        type: 'data-context-summary',
        data: { summary: 'trigger from old work' },
      },
      ...(await loader.carry()),
    ]);
    expect(text([header, first, second])).not.toContain('<skill name=');
    const summaryOnly = message(
      'summary-only',
      await loader.prepare([header, first, second], model),
    );
    expect(text([header, first, second, summaryOnly])).not.toContain(
      '<skill name=',
    );
    const fresh = message('fresh', [{ type: 'text', text: 'trigger again' }]);
    const next = message('next', await loader.prepare([header, fresh], model));
    expect(text([header, fresh, next])).toContain('<skill name=');
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
    ).not.toContain('<skill name=');
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
