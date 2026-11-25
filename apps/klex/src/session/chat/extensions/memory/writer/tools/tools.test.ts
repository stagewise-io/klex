import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asSchema, type ToolSet } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ActivityHistory } from '@/activity-history';
import { createSkillRegistry } from '@/skills';

import { createEntityStore, entityRevision } from '../entities';
import { CURATION_TOOLS, createWriterTools } from './tools';

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
function revision(output: unknown): string {
  const match = String(output).match(/\nrevision\n¦([a-f0-9]+)\n/);
  if (!match?.[1]) throw new Error('Missing revision in memory block');
  return match[1];
}
const fact = (text: string) => ({
  text,
  sources: [{ label: 'old', id: 'old' }],
  history: [],
});
const skillInput = (name: string, extra: object = {}) => ({
  name,
  when: 'Deploying acme/web to staging. Gets the release order right.',
  steps: ['Push head branch first'],
  sourceIds: [source],
  ...extra,
});
const create = (id = source, text = 'Project owner') => ({
  fields: { title: 'Alex Smith', tags: ['people'] },
  sections: [{ name: 'General', facts: [{ text, sourceIds: [id] }] }],
});

describe('memory writer tools', () => {
  it('restricts curation tools and inherits fact sources without conversation evidence', async () => {
    const f = await fixture();
    const entity = await f.entities.create(
      { title: 'Project', tags: ['projects'] },
      { General: [fact('Builds widgets')] },
    );
    const { tools } = createWriterTools({
      ...f,
      skillReader: f.registry,
      mode: 'curation',
      signal: f.controller.signal,
      sourceIds: new Set(),
    });
    expect(Object.keys(tools)).toEqual([...CURATION_TOOLS]);
    expect(
      await call(tools, 'updateEntity', {
        id: entity.id,
        revision: entityRevision(entity),
        fields: {},
        operations: [
          {
            op: 'add',
            section: 'Layout',
            text: 'Builds widgets',
            fromFacts: [{ entity: entity.id, fact: 'General#1' }],
          },
        ],
      }),
    ).toMatchObject({ status: 'updated' });
    expect(f.entities.get(entity.id)?.sections.Layout?.[0]?.sources).toEqual(
      fact('').sources,
    );
    expect(f.activities.readPage).not.toHaveBeenCalled();
    const current = f.entities.get(entity.id);
    if (!current) throw new Error('Missing curated entity');
    expect(
      await call(tools, 'updateEntity', {
        id: entity.id,
        revision: entityRevision(current),
        fields: { loadOn: [{ type: 'contentPattern', pattern: 'xy' }] },
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('existing LoadOn'),
    });
  });
  it('reuses escaped identities and triggers in curation without raw-text evidence checks', async () => {
    const f = await fixture();
    const loadOn = [
      { type: 'contentPattern' as const, pattern: 'deploy\\\\s+"staging"' },
    ];
    const linkedIdentities = [
      { server: 'slack', match: { userId: 'user"quoted\\\\id' } },
    ];
    const entity = await f.entities.create(
      { title: 'Project', tags: ['projects'], loadOn, linkedIdentities },
      { General: [fact('Builds widgets')] },
    );
    await call(f.tools, 'createLearnedSkill', skillInput('deploy'));
    const { tools } = createWriterTools({
      ...f,
      skillReader: f.registry,
      mode: 'curation',
      signal: f.controller.signal,
      sourceIds: new Set(),
    });
    expect(
      await call(tools, 'updateEntity', {
        id: entity.id,
        revision: entityRevision(entity),
        fields: { loadOn, linkedIdentities },
      }),
    ).toMatchObject({ status: 'updated' });
    const read = await call(tools, 'readSkill', { id: 'learning/deploy' });
    expect(
      await call(tools, 'updateLearnedSkill', {
        name: 'deploy',
        revision: revision(read),
        loadOn,
      }),
    ).toMatchObject({ status: 'updated' });
    const updated = await call(tools, 'readSkill', { id: 'learning/deploy' });
    expect(
      await call(tools, 'updateLearnedSkill', {
        name: 'deploy',
        revision: revision(updated),
        loadOn: [{ type: 'contentPattern', pattern: 'new-trigger' }],
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('existing LoadOn'),
    });
  });
  it('exports only structural provider schemas while retaining full local validation', async () => {
    const { tools } = await fixture();
    const check = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect([
          'pattern',
          'patternProperties',
          'propertyNames',
          'format',
          'minLength',
          'maxLength',
          'minimum',
          'maximum',
          'minItems',
          'maxItems',
          'default',
          '$ref',
        ]).not.toContain(key);
        if (key === 'properties' && child && typeof child === 'object') {
          // Property names (including a literal field named pattern) are data.
          for (const property of Object.values(child)) check(property);
        } else check(child);
      }
    };
    for (const tool of Object.values(tools)) {
      check(await asSchema(tool.inputSchema).jsonSchema);
    }
    const readEntity = tools.readEntity;
    if (readEntity === undefined) throw new Error('Missing readEntity tool');
    const schema = asSchema(readEntity.inputSchema);
    for (const section of ['General', 'Known pitfalls', 'Preferences (work)']) {
      expect(
        (await schema.validate?.({ id: 'Ada', sections: [section] }))?.success,
      ).toBe(true);
    }
    for (const section of [
      'Bad[section',
      'Bad]section',
      'Bad#section',
      'Bad<section',
      'Bad>section',
      'Bad\nsection',
      'Bad\rsection',
    ]) {
      expect(
        (await schema.validate?.({ id: 'Ada', sections: [section] }))?.success,
      ).toBe(false);
    }
  });
  it('preserves defaults, normalization, limits and strict predicates before execution', async () => {
    const { tools, entities } = await fixture();
    const list = tools.listEntities;
    const createTool = tools.createEntity;
    if (!list || !createTool) throw new Error('Missing writer tools');
    expect(await asSchema(list.inputSchema).validate?.({})).toMatchObject({
      success: true,
      value: { query: '', offset: 0 },
    });
    const schema = asSchema(createTool.inputSchema);
    const normalized = await schema.validate?.({
      ...create(),
      sections: [
        {
          name: ' General ',
          facts: [{ text: 'Project owner', sourceIds: [source] }],
        },
      ],
    });
    expect(normalized).toMatchObject({
      success: true,
      value: { sections: [{ name: 'General' }] },
    });
    const invalidInputs = [
      { ...create(), fields: { title: 'Ada', tags: ['Invalid Tag'] } },
      { ...create(), fields: { title: 'Ada', tags: [] } },
      {
        ...create(),
        sections: [
          {
            name: 'x'.repeat(101),
            facts: [{ text: 'Owner', sourceIds: [source] }],
          },
        ],
      },
      {
        ...create(),
        fields: {
          title: 'Ada',
          tags: ['people'],
          relatedTo: [
            {
              target: { kind: 'entity', id: 'Other' },
              relationship: 'inventedPredicate',
            },
          ],
        },
      },
      { ...create(), extra: 'unexpected' },
    ];
    for (const input of invalidInputs) {
      expect((await schema.validate?.(input))?.success).toBe(false);
      await expect(call(tools, 'createEntity', input)).rejects.toThrow(
        'Invalid tool input',
      );
    }
    expect(entities.list()).toEqual([]);
    const provider = JSON.stringify(await schema.jsonSchema);
    expect(provider).toContain('worksFor');
    expect(provider).toContain('relatedTo');
  });

  it('creates, searches, reads, relates, renames and merges flat titled memories through tool schemas', async () => {
    const { tools, entities } = await fixture();
    const input = {
      ...create(),
      fields: { title: 'Klex', tags: ['projects/stagewise-io'] },
    };
    const created = (await call(tools, 'createEntity', input)) as {
      id: string;
    };
    expect(created).toMatchObject({
      status: 'created',
      id: 'Klex',
    });
    expect(
      JSON.stringify(await call(tools, 'listEntities', { query: 'klex' })),
    ).toContain(created.id);
    expect(
      await call(tools, 'createEntity', {
        ...create(),
        fields: { title: 'KLEX', tags: ['projects'] },
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('Klex'),
    });
    const read = await call(tools, 'readEntity', { id: created.id });
    expect(revision(read)).toBeTruthy();
    const peer = (await call(tools, 'createEntity', {
      ...create(),
      fields: {
        title: 'Web',
        tags: ['projects/other-org'],
        relatedTo: [
          {
            target: { kind: 'entity', id: created.id },
            relationship: 'uses',
          },
        ],
      },
    })) as { id: string };
    const latest = await call(tools, 'readEntity', { id: created.id });
    const moved = (await call(tools, 'updateEntity', {
      id: created.id,
      revision: revision(latest),
      fields: { title: 'Klex Platform' },
      operations: [],
    })) as { id: string };
    expect(moved.id).toBe('Klex Platform');
    expect(entities.get(peer.id)?.frontmatter.RelatedTo[0]?.target.id).toBe(
      moved.id,
    );
    const keep = await call(tools, 'readEntity', { id: moved.id });
    const drop = await call(tools, 'readEntity', { id: peer.id });
    expect(
      await call(tools, 'mergeEntities', {
        keepId: moved.id,
        dropId: peer.id,
        keepRevision: revision(keep),
        dropRevision: revision(drop),
      }),
    ).toMatchObject({ status: 'merged' });
    expect(entities.get(peer.id)).toBeNull();
  });
  it('maintains exact automatic inverses for multiple predicates, replacements and removals', async () => {
    const { tools, entities } = await fixture();
    const target = await entities.create(
      { title: 'Target Project', tags: ['projects'] },
      { General: [fact('Product')] },
    );
    const input = (relationship: string) => ({
      target: { kind: 'entity', id: target.id },
      relationship,
    });
    for (const relation of [
      input('works on'),
      { ...input('uses'), inverse: 'usedBy' },
    ]) {
      await expect(
        call(tools, 'createEntity', {
          ...create(),
          fields: { ...create().fields, relatedTo: [relation] },
        }),
      ).rejects.toThrow('Invalid tool input');
    }
    const created = (await call(tools, 'createEntity', {
      ...create(),
      fields: {
        ...create().fields,
        relatedTo: [input('uses'), input('dependsOn'), input('uses')],
      },
    })) as { id: string };
    expect(
      entities
        .get(target.id)
        ?.frontmatter.RelatedTo.map(({ relationship }) => relationship)
        .sort(),
    ).toEqual(['requiredBy', 'usedBy']);
    const update = async (relatedTo: unknown[]) => {
      const entity = entities.get(created.id);
      if (!entity) throw new Error('Missing created fixture');
      return call(tools, 'updateEntity', {
        id: entity.id,
        revision: entityRevision(entity),
        fields: { relatedTo },
        operations: [],
      });
    };
    expect(
      await update([input('uses'), input('collaboratesWith')]),
    ).toMatchObject({ status: 'updated' });
    expect(
      entities
        .get(target.id)
        ?.frontmatter.RelatedTo.map(({ relationship }) => relationship)
        .sort(),
    ).toEqual(['collaboratesWith', 'usedBy']);
    const entity = entities.get(created.id);
    if (!entity) throw new Error('Missing fixture');
    await expect(
      call(tools, 'updateEntity', {
        id: entity.id,
        revision: entityRevision(entity),
        fields: { relatedTo: [input('Uses')] },
        operations: [],
      }),
    ).rejects.toThrow('Invalid tool input');
    expect(entities.get(created.id)).toEqual(entity);
    expect(await update([])).toMatchObject({ status: 'updated' });
    expect(entities.get(target.id)?.frontmatter.RelatedTo).toEqual([]);
  });
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
    const read = await call(tools, 'readSkill', { id: 'templates/deploy' });
    expect(read).toContain(`skill ${external.id}\n`);
    expect(read).toContain(`content\n¦${external.body}`);
    expect(revision(read)).toBeTruthy();
    expect(
      await call(tools, 'createEntity', {
        ...create(),
        fields: {
          ...create().fields,
          relatedTo: [
            {
              target: { kind: 'skill', id: external.id },
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
        revision: revision(read),
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
              relationship: 'uses',
            },
          ],
        },
      }),
    ).toMatchObject({ status: 'rejected' });
  });
  it.each([
    { kind: 'entity', id: 'Missing' },
    { kind: 'skill', id: 'templates/missing' },
  ])(
    'rejects invalid $kind references on create and update without writing',
    async (target) => {
      const { tools, entities } = await fixture();
      const relatedTo = [{ target, relationship: 'uses' }];
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
    const read = await call(second, 'readEntity', { id: entity.id });
    expect(read).toContain('facts\n¦[General#1] Project owner');
    expect(JSON.stringify(read)).not.toContain('history:');
    expect(
      await call(second, 'updateEntity', {
        id: entity.id,
        revision: revision(read),
        fields: { tags: ['projects'] },
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
    const updated = entities.get('Alex Smith');
    expect(updated?.frontmatter.Tags).toEqual(['projects']);
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
    expect(await call(second, 'readEntity', { id: 'Alex Smith' })).toContain(
      'facts\n¦[General#1] Former project owner\n¦  was 1: Project owner',
    );
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

  it('merges entities without keeping the dropped name as an alias', async () => {
    const { tools, entities } = await fixture();
    const keep = await entities.create(
      { title: 'Alex Smith', tags: ['people'] },
      { General: [fact('Engineer')] },
    );
    const drop = await entities.create(
      { title: 'Alex S', tags: ['people'] },
      { General: [fact('Owns billing')] },
    );
    const input = {
      keepId: keep.id,
      keepRevision: entityRevision(keep),
      dropId: drop.id,
      dropRevision: entityRevision(drop),
    };
    await expect(
      call(tools, 'mergeEntities', { ...input, dropId: keep.id }),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('same entity'),
    });
    await expect(call(tools, 'mergeEntities', input)).resolves.toMatchObject({
      status: 'merged',
      id: keep.id,
    });
    expect(entities.list()).toHaveLength(1);
    expect(entities.get(drop.id)).toBeNull();
    const created = (await call(tools, 'createEntity', {
      fields: {
        title: 'Billing',
        tags: ['teams'],
        relatedTo: [
          {
            target: { kind: 'entity', id: keep.id },
            relationship: 'hasMember',
          },
        ],
      },
      sections: [
        {
          name: 'General',
          facts: [{ text: 'Handles invoices', sourceIds: [source] }],
        },
      ],
    })) as { id: string };
    expect(entities.get(created.id)?.frontmatter.RelatedTo[0]?.target).toEqual({
      kind: 'entity',
      id: keep.id,
    });
    expect(entities.get(keep.id)?.frontmatter.RelatedTo[0]?.target).toEqual({
      kind: 'entity',
      id: created.id,
    });
  });

  it('rejects a merge whose result exceeds the section limits', async () => {
    const { tools, entities } = await fixture();
    const many = (prefix: string) =>
      Object.fromEntries([
        ['General', [fact(`${prefix} general`)]],
        ...[1, 2, 3].map((n) => [`${prefix} ${n}`, [fact('Detail')]]),
      ]);
    const keep = await entities.create(
      { title: 'Alex Smith', tags: ['people'] },
      many('Keep'),
    );
    const drop = await entities.create(
      { title: 'Alex S', tags: ['people'] },
      many('Drop'),
    );
    await expect(
      call(tools, 'mergeEntities', {
        keepId: keep.id,
        keepRevision: entityRevision(keep),
        dropId: drop.id,
        dropRevision: entityRevision(drop),
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('sections besides General'),
    });
    expect(entities.list()).toHaveLength(2);
  });

  it('rejects a merge whose combined tags exceed the tag limit', async () => {
    const { tools, entities } = await fixture();
    const tags = (prefix: string) =>
      Array.from({ length: 11 }, (_, n) => `${prefix}-${n}`);
    const keep = await entities.create(
      { title: 'Alex Smith', tags: tags('keep') },
      { General: [fact('Engineer')] },
    );
    const drop = await entities.create(
      { title: 'Alex S', tags: tags('drop') },
      { General: [fact('Owns billing')] },
    );
    await expect(
      call(tools, 'mergeEntities', {
        keepId: keep.id,
        keepRevision: entityRevision(keep),
        dropId: drop.id,
        dropRevision: entityRevision(drop),
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('tags 22/20'),
    });
    expect(entities.list()).toHaveLength(2);
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

  it('enforces section count, size and matcher length', async () => {
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
      { title: 'Alex Smith', tags: ['people'] },
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
        title: 'Other Person',
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

  it('renders structured skills, keeps omitted parts, and rejects stale updates', async () => {
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
    const currentRevision = async () =>
      revision(await call(tools, 'readSkill', { id: `learning/${name}` }));
    const update = async (extra: object, rev?: string) =>
      call(tools, 'updateLearnedSkill', {
        name,
        revision: rev ?? (await currentRevision()),
        sourceIds: [source],
        ...extra,
      });
    const stale = await currentRevision();
    expect(await update({ steps: ['Push, then open the PR'] })).toMatchObject({
      status: 'updated',
    });
    expect(skills.get(name)?.body).toContain('1. Push, then open the PR');
    expect(skills.get(name)?.body).toContain('422 head invalid');
    expect(skills.get(name)?.description).toContain('acme/web');
    expect(await update({ pitfalls: [] }, stale)).toMatchObject({
      status: 'rejected',
    });
    for (const extra of [
      { steps: ['Free disk space this run'] },
      { steps: ['Push'], verify: 'Push' },
      { when: 'Deploying acme/web, except on Fridays' },
      { when: "Deploying acme/web when CI can't run" },
      { when: 'Deploying acme/web if staging cannot start' },
    ]) {
      expect(await update(extra)).toMatchObject({ status: 'updated' });
    }
    expect(
      await update({ when: 'Deploying acme/web. Keeps staging in sync.' }),
    ).toMatchObject({ status: 'updated' });
    expect(
      await update({ when: 'Spotting a no-op deploy of acme/web.' }),
    ).toMatchObject({ status: 'updated' });
    expect(skills.get(name)?.body).toContain('1. Push');
    await skills.put('legacy', { description: 'Old', body: 'Prose body.' });
    const legacy = await call(tools, 'readSkill', { id: 'learning/legacy' });
    expect(
      await call(tools, 'updateLearnedSkill', {
        name: 'legacy',
        revision: revision(legacy),
        sourceIds: [source],
        verify: 'x',
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('Free-form skill'),
    });
    const concurrent = {
      name,
      revision: await currentRevision(),
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
        tags: ['projects'],
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
        tags: ['projects'],
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
      await call(tools, 'listEntities', { query: 'MissingUniqueToken' }),
    ).toMatchObject({ entities: [] });
    for (let index = 0; index < 19; index++)
      await entities.create(
        {
          title: `Extra ${index}`,
          tags: ['topics'],
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
      const currentRevision = revision(
        await call(tools, 'readSkill', {
          id: 'learning/pr-body',
        }),
      );
      return call(tools, 'updateLearnedSkill', {
        name: 'pr-body',
        revision: currentRevision,
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
    const withReference = await call(tools, 'readSkill', {
      id: 'learning/deploy',
    });
    expect(withReference).toContain(
      'References (readSkill with reference): flags',
    );
    expect(withReference).not.toContain('loadSkill');
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
    const read = await call(tools, 'readSkill', { id: 'learning/deploy' });
    expect(
      await call(tools, 'deleteLearnedSkill', {
        name: 'deploy',
        revision: revision(read),
      }),
    ).toMatchObject({ status: 'deleted' });
    expect(skills.get('deploy')).toBeNull();
  });
  it.each(['work-items/issues', 'work-items/issues/bugs', 'issue'])(
    'creates %s entities without linked identities or loading triggers',
    async (tag) => {
      const { tools, entities } = await fixture();
      expect(
        await call(tools, 'createEntity', {
          ...create(),
          fields: {
            title: 'CLOUD-254',
            tags: [tag],
          },
        }),
      ).toMatchObject({ status: 'created' });
      expect(entities.get('CLOUD-254')?.frontmatter).toMatchObject({
        Tags: [tag],
        LinkedIdentities: [],
        LoadOn: [],
      });
    },
  );
  it.each(['writer', 'curation'] as const)(
    'allows %s to clear resource identities without replacement triggers',
    async (mode) => {
      const f = await fixture();
      const person = await f.entities.create(
        { title: 'Alex Smith', tags: ['people'] },
        { General: [fact('Owner')] },
      );
      const entity = await f.entities.create(
        {
          title: 'CLOUD-254',
          tags: ['work-items/issues'],
          linkedIdentities: [
            { server: 'linear', match: { issueId: 'issue-1' } },
          ],
          relatedTo: [
            {
              target: { kind: 'entity', id: person.id },
              relationship: 'requestedBy',
            },
          ],
        },
        { General: [fact('Keeps retries bounded')] },
      );
      const { tools } = createWriterTools({
        ...f,
        skillReader: f.registry,
        mode,
        signal: f.controller.signal,
        sourceIds: new Set(),
      });
      expect(
        await call(tools, 'updateEntity', {
          id: entity.id,
          revision: entityRevision(entity),
          fields: { linkedIdentities: [] },
        }),
      ).toMatchObject({ status: 'updated' });
      expect(f.entities.get(entity.id)?.frontmatter).toMatchObject({
        Tags: ['work-items/issues'],
        LinkedIdentities: [],
        LoadOn: [],
        RelatedTo: entity.frontmatter.RelatedTo,
      });
      expect(f.entities.get(entity.id)?.sections).toEqual(entity.sections);
    },
  );
  it.each(['writer', 'curation'] as const)(
    'allows creation and %s updates without tag-dependent semantics',
    async (mode) => {
      const f = await fixture();
      const { tools } = createWriterTools({
        ...f,
        skillReader: f.registry,
        mode,
        signal: f.controller.signal,
        sourceIds: new Set([source]),
      });
      for (const tag of [
        'work-items',
        'work-items/issues/bugs',
        'issue',
        'pull-request',
        'events',
        'events/meetings',
        'event',
        'people',
        'people/colleagues',
        'person',
        'bot',
      ]) {
        const title = `Alex Smith (${tag.replaceAll('/', '-')})`;
        expect(
          await call(f.tools, 'createEntity', {
            ...create(source, 'Alex prefers short replies'),
            fields: { title, tags: [tag] },
          }),
        ).toMatchObject({ status: 'created' });
        const entity = f.entities.get(title);
        if (!entity) throw new Error('Missing entity');
        expect(entity.frontmatter).toMatchObject({
          LinkedIdentities: [],
          LoadOn: [],
          RelatedTo: [],
        });
        expect(
          await call(tools, 'updateEntity', {
            id: entity.id,
            revision: entityRevision(entity),
            fields: { tags: [tag], relatedTo: [] },
            operations: [
              {
                op: 'reword',
                fact: 'General#1',
                text: 'Alex prefers concise replies',
              },
            ],
          }),
        ).toMatchObject({ status: 'updated' });
        expect(f.entities.get(entity.id)?.frontmatter.RelatedTo).toEqual([]);
      }
    },
  );
  it('accepts entity content without semantic restrictions and maintains inverse relations', async () => {
    const { entities, activities, skills, registry, controller } =
      await fixture();
    const tools = createWriterTools({
      entities,
      skills,
      skillReader: registry,
      activities,
      signal: controller.signal,
      sourceIds: new Set([source]),
    }).tools;
    const accept = async (input: unknown) =>
      expect(await call(tools, 'createEntity', input)).toMatchObject({
        status: 'created',
      });
    const fields = (extra: object) => ({
      ...create().fields,
      ...extra,
    });
    await accept(create(source, 'Alex Smith prefers short replies'));
    for (const [title, text] of [
      ['Progress', 'Tests passed on the branch'],
      ['Long fact', 'x'.repeat(161)],
      ['Jonathan', 'Self description'],
    ]) {
      await accept({ ...create(source, text), fields: fields({ title }) });
    }
    await accept({
      ...create(source, 'Slack user U0C33JW11PS'),
      fields: fields({
        title: 'Unquoted identity',
        linkedIdentities: [{ server: 'slack', match: { user: 'U0C33JW11PS' } }],
      }),
    });
    // References still resolve and inverse relations are automatic.
    const issue = (id: string) => ({
      fields: {
        title: 'CLOUD-254',
        tags: ['work-items/issues'],
        linkedIdentities: [{ server: 'linear', match: { issueId: id } }],
        relatedTo: [
          {
            target: { kind: 'entity', id: 'Placeholder' },
            relationship: 'requestedBy',
          },
        ],
      },
      sections: create().sections,
    });
    const person = await entities.create(
      { title: 'Related person', tags: ['people'] },
      { General: [fact('Owner')] },
    );
    const linked = issue('0eff93ac-11f0-4da1-ac13-78d5697ca0e7');
    const relation = linked.fields.relatedTo[0];
    if (!relation) throw new Error('Missing relation');
    relation.target.id = person.id;
    const created = (await call(tools, 'createEntity', linked)) as {
      status: string;
      id: string;
    };
    expect(created.status).toBe('created');
    // One call linked both sides.
    expect(entities.get(person.id)?.frontmatter.RelatedTo).toEqual([
      {
        target: { kind: 'entity', id: created.id },
        relationship: 'requested',
      },
    ]);
    expect(entities.get(created.id)?.frontmatter.RelatedTo[0]).toEqual({
      target: { kind: 'entity', id: person.id },
      relationship: 'requestedBy',
    });
  });
  it('allows distinct skills with overlapping names and triggers', async () => {
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
      status: 'created',
    });
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
          title: 'acme web',
          tags: ['repositories'],
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
    const read = await call(tools, 'readSkill', {
      id: `learning/${input.name}`,
    });
    await call(tools, 'updateLearnedSkill', {
      name: input.name,
      revision: revision(read),
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
                id: 'Missing',
              },
              relationship: 'collaboratesWith',
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
