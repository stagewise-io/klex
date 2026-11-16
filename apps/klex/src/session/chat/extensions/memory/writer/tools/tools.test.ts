import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asSchema, type ToolSet } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ActivityHistory } from '@/activity-history';
import { createSkillRegistry } from '@/skills';

import { createEntityStore, entityRevision } from '../entities';
import { createWriterTools } from './tools';

const directories: string[] = [];
const source = 'message-1';
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'memory-tools-'));
  directories.push(directory);
  const logger = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  } as unknown as ModuleLogger;
  const registry = createSkillRegistry({ dataDirectory: directory, logger });
  await registry.start();
  registry.claimNamespace('io.stagewise/memory-writer', 'learning');
  const skills = registry.forNamespace('learning');
  const entities = createEntityStore(join(directory, 'entities'));
  await entities.start();
  const controller = new AbortController();
  const activities = {
    readPage: vi.fn(async () => ({
      text: 'source',
      startedAt: '2026-11-12T14:00:00.000Z',
      platforms: ['slack'],
      truncated: false,
    })),
  } as unknown as ActivityHistory;
  const { tools } = createWriterTools({
    skills,
    skillReader: registry,
    entities,
    activities,
    signal: controller.signal,
    sourceIds: new Set([source]),
  });
  return { tools, skills, entities, controller, registry, activities };
}
async function call(
  tools: ToolSet,
  name: string,
  input: unknown,
): Promise<unknown> {
  const tool = tools[name];
  if (!tool?.execute) throw new Error('Missing tool');
  const validated = await asSchema(tool.inputSchema).validate?.(input);
  if (!validated?.success) throw new Error('Invalid tool input');
  return tool.execute(validated.value, {
    toolCallId: 'test',
    messages: [],
    context: undefined,
  });
}
const fact = (text: string) => ({
  text,
  sources: [{ label: 'old', id: 'old' }],
  history: [],
});
const skillInput = (name: string, extra: object = {}) => ({
  name,
  when: 'Use when deploying acme/web to staging; not production',
  steps: ['Push head branch first'],
  sourceIds: [source],
  ...extra,
});
const create = (id = source, text = 'Project owner') => ({
  fields: { title: 'Alex Smith', entityType: 'person' },
  sections: [{ name: 'General', facts: [{ text, sourceIds: [id] }] }],
});

describe('memory writer tools', () => {
  it('reads and relates all skill namespaces but only writes learning', async () => {
    const { tools, registry, entities } = await fixture();
    await registry.replaceTemplateSkills([
      {
        name: 'deploy',
        description: 'Deploy template',
        body: 'Use the approved deployment process.',
      },
    ]);
    const external = registry.get('templates/deploy');
    if (!external) throw new Error('Missing template fixture');
    expect(await call(tools, 'listSkills', {})).toContainEqual({
      id: 'templates/deploy',
      description: external.description,
    });
    const read = (await call(tools, 'readSkill', {
      id: 'templates/deploy',
    })) as { revision: string };
    expect(read).toMatchObject({ id: external.id, body: external.body });
    expect(
      await call(tools, 'createEntity', {
        ...create(),
        fields: {
          ...create().fields,
          relatedTo: [
            {
              target: { kind: 'skill', id: external.id },
              strength: 80,
              relationship: 'uses',
            },
          ],
        },
      }),
    ).toMatchObject({ status: 'created' });
    expect(entities.list()[0]?.frontmatter.RelatedTo[0]?.target.id).toBe(
      external.id,
    );
    await expect(
      call(tools, 'updateLearnedSkill', {
        ...skillInput(external.id),
        revision: read.revision,
      }),
    ).rejects.toThrow('Invalid tool input');
    await expect(
      call(tools, 'createLearnedSkill', skillInput(external.id)),
    ).rejects.toThrow('Invalid tool input');
    expect(registry.get(external.id)?.body).toBe(external.body);
    expect(
      await call(tools, 'createEntity', {
        ...create(),
        fields: {
          ...create().fields,
          relatedTo: [
            {
              target: { kind: 'skill', id: 'templates/missing' },
              strength: 80,
              relationship: 'uses',
            },
          ],
        },
      }),
    ).toMatchObject({ status: 'rejected' });
  });
  it.each([
    { kind: 'entity', id: '00000000-0000-4000-8000-000000000000' },
    { kind: 'skill', id: 'templates/missing' },
  ])(
    'rejects invalid $kind references on create and update without writing',
    async (target) => {
      const { tools, entities } = await fixture();
      const relatedTo = [{ target, strength: 80, relationship: 'uses' }];
      const rejected = {
        status: 'rejected',
        reason: `Invalid reference: ${target.kind} "${target.id}" does not exist`,
      };
      expect(
        await call(tools, 'createEntity', {
          ...create(),
          fields: { ...create().fields, relatedTo },
        }),
      ).toEqual(rejected);
      expect(entities.list()).toHaveLength(0);
      await call(tools, 'createEntity', create());
      const entity = entities.list()[0];
      if (!entity) throw new Error('Missing entity fixture');
      expect(
        await call(tools, 'updateEntity', {
          id: entity.id,
          revision: entityRevision(entity),
          fields: { relatedTo },
          operations: [
            {
              op: 'add',
              section: 'General',
              text: 'Must not persist',
              sourceIds: [source],
            },
          ],
        }),
      ).toEqual(rejected);
      expect(entities.get(entity.id)).toEqual(entity);
    },
  );
  it('revalidates retained references and allows removing a broken reference', async () => {
    const { tools, registry, entities } = await fixture();
    await registry.replaceTemplateSkills([
      { name: 'deploy', description: 'Deploy', body: 'Deploy safely.' },
    ]);
    await call(tools, 'createEntity', {
      ...create(),
      fields: {
        ...create().fields,
        relatedTo: [
          {
            target: { kind: 'skill', id: 'templates/deploy' },
            strength: 80,
            relationship: 'uses',
          },
        ],
      },
    });
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity fixture');
    await registry.replaceTemplateSkills([]);
    const update = {
      id: entity.id,
      revision: entityRevision(entity),
      fields: { title: 'New title' },
    };
    expect(await call(tools, 'updateEntity', update)).toEqual({
      status: 'rejected',
      reason: 'Invalid reference: skill "templates/deploy" does not exist',
    });
    expect(entities.get(entity.id)).toEqual(entity);
    expect(
      await call(tools, 'updateEntity', {
        ...update,
        fields: { relatedTo: [] },
      }),
    ).toMatchObject({ status: 'updated' });
  });
  it('validates citations with the same raw-body budget as replay', async () => {
    const { tools, activities } = await fixture();
    expect(await call(tools, 'createEntity', create())).toMatchObject({
      status: 'created',
    });
    expect(activities.readPage).toHaveBeenCalledWith(
      source,
      expect.objectContaining({ maxBytes: 2_000_000 }),
    );
  });
  it('writes facts with inline date citations and reads them without citations', async () => {
    const { entities, skills, activities, controller, registry } =
      await fixture();
    const batch = (id: string) =>
      createWriterTools({
        entities,
        skills,
        skillReader: registry,
        activities,
        signal: controller.signal,
        sourceIds: new Set([id]),
      }).tools;
    const first = batch(source);
    await call(first, 'createEntity', create(source));
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    expect(entity.sections.General).toEqual([
      {
        text: 'Project owner',
        sources: [{ label: '2026-11-12 · slack', id: source }],
        history: [],
      },
    ]);
    const second = batch('message-2');
    expect(
      await call(second, 'createEntity', create('unknown-message')),
    ).toMatchObject({ status: 'rejected' });
    expect(await call(second, 'createEntity', create(source))).toMatchObject({
      status: 'rejected',
    });
    const read = (await call(second, 'readEntity', { id: entity.id })) as {
      revision: string;
      sections: Record<string, string>;
    };
    expect(read.sections).toEqual({ General: '[General#1] Project owner' });
    expect(JSON.stringify(read)).not.toContain('history:');
    expect(
      await call(second, 'updateEntity', {
        id: entity.id,
        revision: read.revision,
        fields: { entityType: 'project' },
        operations: [
          {
            op: 'supersede',
            fact: 'General#1',
            text: 'Former project owner',
            sourceIds: ['message-2'],
          },
        ],
      }),
    ).toMatchObject({ status: 'updated' });
    const updated = entities.get(entity.id);
    expect(updated?.entityType).toBe('project');
    expect(updated?.sections.General?.[0]).toEqual({
      text: 'Former project owner',
      sources: [{ label: '2026-11-12 · slack', id: 'message-2' }],
      history: [
        {
          text: 'Project owner',
          sources: [{ label: '2026-11-12 · slack', id: source }],
        },
      ],
    });
    expect(
      (
        (await call(second, 'readEntity', { id: entity.id })) as {
          sections: Record<string, string>;
        }
      ).sections.General,
    ).toBe('[General#1] Former project owner\n  was 1: Project owner');
    await call(
      second,
      'createLearnedSkill',
      skillInput('source-test', { sourceIds: ['message-2'] }),
    );
    expect(skills.get('source-test')?.metadata.sourceEpisodes).toEqual([
      'message-2',
    ]);
    controller.abort();
    expect(
      await call(second, 'createEntity', create('message-2')),
    ).toMatchObject({ status: 'cancelled' });
  });

  it('rejects concurrent stale entity commits', async () => {
    const { tools, entities } = await fixture();
    await call(tools, 'createEntity', create());
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    const input = {
      id: entity.id,
      revision: entityRevision(entity),
      fields: {},
      operations: [
        {
          op: 'add',
          section: 'General',
          text: 'Concurrent',
          sourceIds: [source],
        },
      ],
    };
    const results = await Promise.all([
      call(tools, 'updateEntity', input),
      call(tools, 'updateEntity', input),
    ]);
    expect(
      results.filter(
        (result) => (result as { status: string }).status === 'updated',
      ),
    ).toHaveLength(1);
  });

  it('supersedes, rewords, merges, restores, moves and removes facts by read address', async () => {
    const { tools, entities } = await fixture();
    await call(tools, 'createEntity', {
      ...create(),
      sections: [
        {
          name: 'General',
          facts: [
            { text: 'Owns Atlas', sourceIds: [source] },
            { text: 'Lives in Berlin', sourceIds: [source] },
            { text: 'Lives in Berlin, Germany', sourceIds: [source] },
          ],
        },
      ],
    });
    const id = entities.list()[0]?.id ?? '';
    const update = async (operations: unknown[]) => {
      const current = entities.get(id);
      if (!current) throw new Error('Missing entity');
      return call(tools, 'updateEntity', {
        id,
        revision: entityRevision(current),
        fields: {},
        operations,
      });
    };
    const general = () =>
      entities.get(id)?.sections.General?.map((fact) => fact.text);
    expect(
      await update([
        {
          op: 'merge',
          facts: ['General#2', 'General#3'],
          text: 'Lives in Berlin',
        },
        {
          op: 'supersede',
          fact: 'General#1',
          text: 'Owns Zeus',
          sourceIds: [source],
        },
      ]),
    ).toMatchObject({ status: 'updated' });
    expect(general()).toEqual(['Owns Zeus', 'Lives in Berlin']);
    // Supersede twice more, then restore the original claim (e.g. joke retracted).
    await update([
      {
        op: 'supersede',
        fact: 'General#1',
        text: 'Owns Hera',
        sourceIds: [source],
      },
    ]);
    await update([
      { op: 'restore', fact: 'General#1', version: 2, sourceIds: [source] },
    ]);
    expect(entities.get(id)?.sections.General?.[0]).toMatchObject({
      text: 'Owns Atlas',
      history: [{ text: 'Owns Hera' }, { text: 'Owns Zeus' }],
    });
    await update([
      { op: 'reword', fact: 'General#2', text: 'Lives: Berlin' },
      { op: 'move', fact: 'General#2', destination: 'Home' },
    ]);
    expect(entities.get(id)?.sections.Home?.[0]?.text).toBe('Lives: Berlin');
    await update([
      { op: 'renameSection', section: 'Home', destination: 'Residence' },
    ]);
    await update([{ op: 'remove', fact: 'Residence#1' }]);
    expect(Object.keys(entities.get(id)?.sections ?? {})).toEqual(['General']);
    const before = entities.get(id);
    for (const operations of [
      [{ op: 'remove', fact: 'General#1' }],
      [{ op: 'supersede', fact: 'General#1', text: 'No evidence' }],
      [{ op: 'add', section: 'General', text: 'No evidence' }],
      [{ op: 'reword', fact: 'General#9', text: 'Missing' }],
      [{ op: 'merge', facts: ['General#1'], text: 'One' }],
      [{ op: 'restore', fact: 'General#1', version: 3, sourceIds: [source] }],
      [{ op: 'renameSection', section: 'General', destination: 'Other' }],
      [
        {
          op: 'add',
          section: 'General',
          text: 'history:forged',
          sourceIds: [source],
        },
      ],
      [
        { op: 'add', section: 'General', text: 'Valid', sourceIds: [source] },
        { op: 'move', fact: 'General#1', destination: 'General' },
      ],
    ])
      expect(await update(operations)).toMatchObject({ status: 'rejected' });
    expect(entities.get(id)).toEqual(before);
  });

  it('enforces section count, size, identity repetition and matcher length', async () => {
    const { tools, entities } = await fixture();
    const section = (name: string, text = 'Fact') => ({
      name,
      facts: [{ text, sourceIds: [source] }],
    });
    const wide = {
      name: 'General',
      facts: Array.from({ length: 5 }, () => ({
        text: 'x'.repeat(150),
        sourceIds: [source],
      })),
    };
    const reject = async (input: unknown, reason: string) =>
      expect(await call(tools, 'createEntity', input)).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining(reason),
      });
    await reject({ ...create(), sections: [wide] }, 'General exceeds 600');
    await reject(
      {
        ...create(),
        fields: {
          ...create().fields,
          loadOn: [{ type: 'contentPattern', pattern: 'x'.repeat(61) }],
        },
      },
      'exceeds 60',
    );
    await reject(
      {
        ...create(),
        fields: {
          ...create().fields,
          linkedIdentities: [
            { server: 'slack', match: { user: 'U071HL78SDN' } },
          ],
        },
        sections: [section('General', 'Slack user U071HL78SDN')],
      },
      'repeats linked identity',
    );
    expect(entities.list()).toHaveLength(0);
    const created = await call(tools, 'createEntity', {
      ...create(),
      sections: ['General', 'A', 'B', 'C', 'D'].map((n) => section(n)),
    });
    expect(created).toMatchObject({ status: 'created' });
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    expect(
      await call(tools, 'updateEntity', {
        id: entity.id,
        revision: entityRevision(entity),
        fields: {},
        operations: [
          { op: 'add', section: 'E', text: 'Fact', sourceIds: [source] },
        ],
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('Max 4 sections'),
    });
  });

  it('caps merged citations at the newest six and reports identity conflicts', async () => {
    const { tools, entities } = await fixture();
    const old = Array.from({ length: 8 }, (_, i) => ({
      label: 'old',
      id: `old${i}`,
    }));
    const entity = await entities.create(
      { title: 'Alex Smith', entityType: 'person' },
      { General: [{ text: 'Owns Atlas', sources: old, history: [] }] },
    );
    await call(tools, 'updateEntity', {
      id: entity.id,
      revision: entityRevision(entity),
      fields: {},
      operations: [
        {
          op: 'reword',
          fact: 'General#1',
          text: 'Owns Atlas.',
          sourceIds: [source],
        },
      ],
    });
    const sources = entities.get(entity.id)?.sections.General?.[0]?.sources;
    expect(sources).toHaveLength(6);
    expect(sources?.at(-1)?.id).toBe(source);
    await call(tools, 'createEntity', {
      ...create(),
      fields: {
        ...create().fields,
        linkedIdentities: [{ server: 'slack', match: { user: 'U1' } }],
      },
    });
    expect(
      await call(tools, 'createEntity', {
        ...create(),
        fields: {
          ...create().fields,
          linkedIdentities: [{ server: 'slack', match: { user: 'U1' } }],
        },
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('already belongs to entity'),
    });
  });

  it('renders structured skills, keeps omitted parts, and rejects stale, run-specific or duplicate input', async () => {
    const { tools, skills } = await fixture();
    const name = 'patch-workflow';
    await call(
      tools,
      'createLearnedSkill',
      skillInput(name, {
        pitfalls: ['422 head invalid: branch not pushed'],
        verify: 'PR page opens',
      }),
    );
    expect(skills.get(name)?.body).toBe(
      '## Steps\n1. Push head branch first\n\n## Pitfalls\n- 422 head invalid: branch not pushed\n\n## Verify\nPR page opens',
    );
    const revision = async () =>
      (
        (await call(tools, 'readSkill', { id: `learning/${name}` })) as {
          revision: string;
        }
      ).revision;
    const update = async (extra: object, rev?: string) =>
      call(tools, 'updateLearnedSkill', {
        name,
        revision: rev ?? (await revision()),
        sourceIds: [source],
        ...extra,
      });
    const stale = await revision();
    expect(await update({ steps: ['Push, then open the PR'] })).toMatchObject({
      status: 'updated',
    });
    expect(skills.get(name)?.body).toContain('1. Push, then open the PR');
    expect(skills.get(name)?.body).toContain('422 head invalid');
    expect(skills.get(name)?.description).toContain('acme/web');
    expect(await update({ pitfalls: [] }, stale)).toMatchObject({
      status: 'rejected',
    });
    const reject = async (extra: object, reason: string) =>
      expect(await update(extra)).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining(reason),
      });
    await reject({ steps: ['Free disk space this run'] }, 'ties it to one run');
    await reject({ steps: ['Push'], verify: 'Push' }, 'verify repeats a step');
    expect(skills.get(name)?.body).toContain('Push, then open the PR');
    await skills.put('legacy', { description: 'Old', body: 'Prose body.' });
    const legacy = (await call(tools, 'readSkill', {
      id: 'learning/legacy',
    })) as { revision: string };
    expect(
      await call(tools, 'updateLearnedSkill', {
        name: 'legacy',
        revision: legacy.revision,
        sourceIds: [source],
        verify: 'x',
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('Free-form skill'),
    });
    const concurrent = {
      name,
      revision: await revision(),
      sourceIds: [source],
      steps: ['Once'],
    };
    const results = await Promise.all([
      call(tools, 'updateLearnedSkill', concurrent),
      call(tools, 'updateLearnedSkill', concurrent),
    ]);
    expect(
      results.filter(
        (result) => (result as { status: string }).status === 'updated',
      ),
    ).toHaveLength(1);
  });
  it('ranks full-document matches, returns bounded snippets, excludes sources, and paginates', async () => {
    const { tools, entities } = await fixture();
    const detail = await entities.create(
      {
        title: 'Other project',
        entityType: 'project',
        loadOn: [],
        relatedTo: [],
      },
      {
        General: [fact('Overview')],
        Schedule: [
          fact(
            `${'padding '.repeat(60)}Launch 2027-03-10 ${'suffix '.repeat(50)}`,
          ),
        ],
      },
    );
    const title = await entities.create(
      {
        title: 'Launch plan',
        entityType: 'project',
        loadOn: [],
        relatedTo: [],
      },
      { General: [fact('Overview')] },
    );
    const results = (await call(tools, 'listEntities', {
      query: 'launch',
    })) as {
      entities: {
        id: string;
        general: string;
        matches: { section: string; text: string }[];
      }[];
    };
    expect(results.entities.map(({ id }) => id)).toEqual([title.id, detail.id]);
    expect(results.entities[0]).not.toHaveProperty('score');
    expect(results.entities[0]?.matches).toEqual([]);
    expect(results.entities[1]?.matches).toEqual([
      expect.objectContaining({
        section: 'Schedule',
        text: expect.stringContaining('Launch 2027-03-10'),
      }),
    ]);
    expect(results.entities[1]?.matches[0]?.text.length).toBeLessThanOrEqual(
      242,
    );
    expect(
      await call(tools, 'listEntities', { query: '2027-03-10' }),
    ).toMatchObject({ entities: [{ id: detail.id }] });
    expect(
      await call(tools, 'listEntities', { query: '2026-11-12' }),
    ).toMatchObject({ entities: [] });
    expect(
      await call(tools, 'listEntities', { query: detail.id }),
    ).toMatchObject({ entities: [] });
    for (let index = 0; index < 19; index++)
      await entities.create(
        {
          title: `Extra ${index}`,
          entityType: 'topic',
          loadOn: [],
          relatedTo: [],
        },
        { General: [fact('Overview')] },
      );
    expect(await call(tools, 'listEntities', {})).toMatchObject({
      nextOffset: 20,
      entities: expect.any(Array),
    });
    expect(await call(tools, 'listEntities', { offset: 20 })).toMatchObject({
      nextOffset: null,
      entities: [expect.any(Object)],
    });
  });
  it('stores, replaces and keeps skill LoadOn in registry metadata', async () => {
    const { tools, skills } = await fixture();
    const trigger = {
      type: 'toolCallPattern',
      mcpServer: 'github',
      toolName: 'create_pull_request',
      arguments: [],
    };
    await call(
      tools,
      'createLearnedSkill',
      skillInput('pr-body', { loadOn: [trigger, trigger] }),
    );
    expect(skills.get('pr-body')?.metadata.loadOn).toEqual([trigger]);
    const update = async (extra: object) => {
      const { revision } = (await call(tools, 'readSkill', {
        id: 'learning/pr-body',
      })) as { revision: string };
      return call(tools, 'updateLearnedSkill', {
        name: 'pr-body',
        revision,
        sourceIds: [source],
        steps: [`Step ${Math.random()}`],
        ...extra,
      });
    };
    await update({});
    expect(skills.get('pr-body')?.metadata.loadOn).toEqual([trigger]);
    await update({ loadOn: [] });
    expect(skills.get('pr-body')?.metadata.loadOn).toEqual([]);
    expect(skills.get('pr-body')?.metadata.sourceEpisodes).toEqual([source]);
  });
  it('writes, reads and deletes learned skill references and skills', async () => {
    const { tools, skills } = await fixture();
    await call(tools, 'createLearnedSkill', skillInput('deploy'));
    expect(
      await call(tools, 'writeSkillReference', {
        name: 'deploy',
        reference: 'flags',
        content: '`--dry-run` first.',
        sourceIds: [source],
      }),
    ).toMatchObject({ status: 'written', references: ['flags'] });
    expect(
      await call(tools, 'readSkill', {
        id: 'learning/deploy',
        reference: 'flags',
      }),
    ).toEqual({
      id: 'learning/deploy',
      reference: 'flags',
      content: '`--dry-run` first.',
    });
    expect(
      await call(tools, 'deleteSkillReference', {
        name: 'deploy',
        reference: 'flags',
      }),
    ).toEqual({ status: 'deleted' });
    const read = (await call(tools, 'readSkill', {
      id: 'learning/deploy',
    })) as { revision: string };
    expect(
      await call(tools, 'deleteLearnedSkill', {
        name: 'deploy',
        revision: read.revision,
      }),
    ).toMatchObject({ status: 'deleted' });
    expect(skills.get('deploy')).toBeNull();
  });
  it('rejects entity output a cheap model gets wrong, with a fix in the message', async () => {
    const evidence =
      'issue 0eff93ac-11f0-4da1-ac13-78d5697ca0e7 PR_kwDOT3Z8XM8AAAABO4mHbw';
    const { tools, entities, activities, skills, registry, controller } =
      await fixture();
    const strict = createWriterTools({
      entities,
      skills,
      skillReader: registry,
      activities,
      signal: controller.signal,
      sourceIds: new Set([source]),
      selfName: 'Jonathan',
      evidenceText: evidence,
    }).tools;
    const reject = async (input: unknown, reason: string) =>
      expect(await call(strict, 'createEntity', input)).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining(reason),
      });
    const fields = (extra: object) => ({
      ...create().fields,
      ...extra,
    });
    await reject(
      create(source, 'Alex Smith prefers short replies'),
      'Drop the subject',
    );
    await reject(
      create(source, 'Alex prefers short replies'),
      'Drop the subject',
    );
    await reject(
      create(source, 'Tests passed on the branch'),
      'progress or status',
    );
    await reject(create(source, 'x'.repeat(161)), 'max 160');
    await reject(
      { ...create(), fields: fields({ title: 'Jonathan' }) },
      'is self',
    );
    await reject(
      {
        ...create(),
        fields: fields({
          linkedIdentities: [
            { server: 'slack', match: { user: 'U0C33JW11PS' } },
          ],
        }),
      },
      'not found in the activities',
    );
    await reject(
      {
        ...create(),
        fields: fields({
          title: 'CLOUD-254',
          entityType: 'issue',
          linkedIdentities: [
            {
              server: 'github',
              match: { subjectNodeId: 'PR_kwDOT3Z8XM8AAAABO4mHbw' },
            },
          ],
        }),
      },
      'pull-request',
    );
    await reject(
      {
        ...create(),
        fields: fields({ title: 'PR 12', entityType: 'pull-request' }),
      },
      'Link who requested',
    );
    expect(entities.list()).toHaveLength(0);
    // Copied exactly: accepted, and a truncated Linear ID is not.
    const issue = (id: string) => ({
      fields: {
        title: 'CLOUD-254',
        entityType: 'issue',
        linkedIdentities: [{ server: 'linear', match: { issueId: id } }],
        relatedTo: [
          {
            target: { kind: 'entity', id: 'placeholder' },
            strength: 50,
            relationship: 'requested by',
            inverse: 'requested',
          },
        ],
      },
      sections: create().sections,
    });
    await reject(
      issue('0eff93ac-11f0-4da1-ac13-78d5697ca0'),
      'not found in the activities',
    );
    const person = await entities.create(
      { title: 'Alex Smith', entityType: 'person' },
      { General: [fact('Owner')] },
    );
    const linked = issue('0eff93ac-11f0-4da1-ac13-78d5697ca0e7');
    const relation = linked.fields.relatedTo[0];
    if (!relation) throw new Error('Missing relation');
    relation.target.id = person.id;
    const created = (await call(strict, 'createEntity', linked)) as {
      status: string;
      id: string;
    };
    expect(created.status).toBe('created');
    // One call linked both sides.
    expect(entities.get(person.id)?.frontmatter.RelatedTo).toEqual([
      {
        target: { kind: 'entity', id: created.id },
        strength: 50,
        relationship: 'requested',
      },
    ]);
    expect(entities.get(created.id)?.frontmatter.RelatedTo[0]).toEqual({
      target: { kind: 'entity', id: person.id },
      strength: 50,
      relationship: 'requested by',
    });
  });
  it('rejects a new skill that duplicates an existing one', async () => {
    const { tools } = await fixture();
    const trigger = {
      type: 'toolCallPattern',
      mcpServer: 'linear',
      toolName: 'createLinearAgentActivity',
      arguments: [],
    };
    await call(
      tools,
      'createLearnedSkill',
      skillInput('linear-agent-session-response', { loadOn: [trigger] }),
    );
    const duplicate = skillInput('linear-installation-context', {
      loadOn: [trigger],
    });
    expect(await call(tools, 'createLearnedSkill', duplicate)).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining(
        'Similar: learning/linear-agent-session-response',
      ),
    });
    expect(
      await call(tools, 'createLearnedSkill', {
        ...duplicate,
        notDuplicateOf: ['learning/linear-agent-session-response'],
      }),
    ).toMatchObject({ status: 'created' });
  });
  it('rejects credentials in entity and skill writes', async () => {
    const { tools, entities, skills } = await fixture();
    const token = 'ghs_abcdefghijklmnopqrstuvwxyz123456';
    const rejected = await call(
      tools,
      'createEntity',
      create(source, `Deploy token ${token}`),
    );
    expect(rejected).toEqual({
      status: 'rejected',
      reason: 'Input contains a credential; never store secrets',
    });
    expect(
      await call(
        tools,
        'createLearnedSkill',
        skillInput('deploy', {
          steps: [`curl -H "Authorization: Bearer ${token}"`],
        }),
      ),
    ).toMatchObject({ status: 'rejected' });
    const prose = (text: string) =>
      call(tools, 'createEntity', create(source, text));
    expect(await prose('Signing key 9f8a7b6c5d4e3f2a1b0c9d8e')).toMatchObject({
      status: 'rejected',
    });
    expect(entities.list()).toEqual([]);
    expect(skills.get('deploy')).toBeNull();
    // Human-scale IDs stay; machine IDs belong in LinkedIdentities, which are exempt.
    expect(
      await prose(
        'Owns CLOUD-11682 and acme/web; Slack U0C33JW11PS; issue 3f2b8c1e-4a5d-4e6f-9b7a-1c2d3e4f5a6b',
      ),
    ).toMatchObject({ status: 'created' });
    expect(
      await call(tools, 'createEntity', {
        fields: {
          title: 'acme/web',
          entityType: 'repository',
          linkedIdentities: [
            {
              server: 'github',
              match: { subjectNodeId: 'PR_kwDOAbCdEf12345678ghIJ' },
            },
          ],
        },
        sections: [
          {
            name: 'General',
            facts: [{ text: 'Adds login', sourceIds: [source] }],
          },
        ],
      }),
    ).toMatchObject({ status: 'created' });
  });
  it('writes validated citations with environmental timestamp/platform, rejects invented evidence', async () => {
    const { tools, entities } = await fixture();
    expect(
      await call(tools, 'createEntity', create('history:invented')),
    ).toMatchObject({ status: 'rejected' });
    await call(tools, 'createEntity', create());
    expect(entities.list()[0]?.sections.General?.[0]?.sources).toEqual([
      { label: '2026-11-12 · slack', id: source },
    ]);
    await expect(
      call(tools, 'createEntity', {
        ...create(),
        fields: { ...create().fields, CreatedAt: 'forged' },
      }),
    ).rejects.toThrow('Invalid tool input');
    expect(entities.list()).toHaveLength(1);
  });
  it('restricts skills to create/update in learning and rejects qualified names', async () => {
    const { tools, skills, registry } = await fixture();
    const input = skillInput('deploy-workflow');
    await call(tools, 'createLearnedSkill', input);
    expect(skills.get(input.name)?.body).toContain('Push head branch first');
    expect(await call(tools, 'createLearnedSkill', input)).toMatchObject({
      status: 'rejected',
    });
    const read = (await call(tools, 'readSkill', {
      id: `learning/${input.name}`,
    })) as { revision: string };
    await call(tools, 'updateLearnedSkill', {
      name: input.name,
      revision: read.revision,
      sourceIds: [source],
      steps: ['Updated workflow'],
    });
    expect(skills.get(input.name)?.body).toContain('1. Updated workflow');
    await expect(
      call(tools, 'createLearnedSkill', { ...input, name: 'templates/escape' }),
    ).rejects.toThrow();
    expect(
      registry.list().every((skill) => skill.namespace === 'learning'),
    ).toBe(true);
    expect(tools.recordRead).toBeUndefined();
  });
  it('rejects missing relation targets, preserves unrelated sections, and cancels writes', async () => {
    const { tools, entities, controller } = await fixture();
    await call(tools, 'createEntity', create());
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    expect(
      await call(tools, 'updateEntity', {
        id: entity.id,
        revision: entityRevision(entity),
        fields: {
          relatedTo: [
            {
              target: {
                kind: 'entity',
                id: '00000000-0000-4000-8000-000000000000',
              },
              strength: 80,
              relationship: 'colleague',
            },
          ],
        },
      }),
    ).toMatchObject({ status: 'rejected' });
    await call(tools, 'updateEntity', {
      id: entity.id,
      revision: entityRevision(entity),
      fields: {},
      operations: [
        {
          op: 'add',
          section: 'Details',
          text: 'More facts',
          sourceIds: [source],
        },
      ],
    });
    expect(entities.get(entity.id)?.sections.General).toEqual(
      entity.sections.General,
    );
    controller.abort();
    expect(await call(tools, 'createEntity', create())).toMatchObject({
      status: 'cancelled',
    });
    expect(entities.list()).toHaveLength(1);
  });
});
