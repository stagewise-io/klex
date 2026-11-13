import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asSchema, type ToolSet } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ActivityHistory } from '@/activity-history';
import { createSkillRegistry } from '@/skills';

import { createEntityStore, entityRevision } from '../entities';
import { createWriterTools } from './writer-tools';

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
const create = (id = source) => ({
  fields: { title: 'Alex Smith', entityType: 'person' },
  sections: [{ name: 'General', content: 'Project owner', sourceIds: [id] }],
});

describe('memory writer tools', () => {
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
  it('reads citations unchanged and writes SQLite message IDs directly', async () => {
    const { entities, skills, activities, controller } = await fixture();
    const batch = (id: string) =>
      createWriterTools({
        entities,
        skills,
        activities,
        signal: controller.signal,
        sourceIds: new Set([id]),
      }).tools;
    const first = batch(source);
    await call(first, 'createEntity', create(source));
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    expect(entity.sections.General).toContain(`(history:${source})`);
    const second = batch('message-2');
    expect(
      await call(second, 'createEntity', create('unknown-message')),
    ).toMatchObject({
      status: 'rejected',
    });
    expect(await call(second, 'createEntity', create(source))).toMatchObject({
      status: 'rejected',
    });
    const read = (await call(second, 'readEntity', {
      id: entity.frontmatter.Id,
    })) as { revision: string; sections: Record<string, string> };
    expect(read.sections.General).toBe(entity.sections.General);
    expect(
      await call(second, 'updateEntity', {
        id: entity.frontmatter.Id,
        revision: read.revision,
        fields: { entityType: 'project' },
        operations: [
          {
            op: 'replace',
            section: 'General',
            text: 'Corrected fact',
            sourceIds: ['message-2'],
            removeSourceIds: [source],
          },
        ],
      }),
    ).toMatchObject({ status: 'updated' });
    expect(entities.get(entity.frontmatter.Id)?.entityType).toBe('project');
    expect(entities.get(entity.frontmatter.Id)?.frontmatter).not.toHaveProperty(
      'EntityType',
    );
    expect(entities.get(entity.frontmatter.Id)?.sections.General).toContain(
      '(history:message-2)',
    );
    expect(entities.get(entity.frontmatter.Id)?.sections.General).not.toContain(
      source,
    );
    await call(second, 'createLearnedSkill', {
      name: 'source-test',
      description: 'Test',
      body: 'Steps',
      sourceIds: ['message-2'],
    });
    expect(skills.get('source-test')?.metadata.sourceEpisodes).toEqual([
      'message-2',
    ]);
    const skill = (await call(second, 'readLearnedSkill', {
      name: 'source-test',
    })) as { revision: string };
    expect(skill).toMatchObject({
      metadata: { sourceEpisodes: ['message-2'] },
    });
    await call(second, 'updateLearnedSkill', {
      name: 'source-test',
      revision: skill.revision,
      sourceIds: ['message-2'],
      operations: [{ op: 'append', text: 'More steps' }],
    });
    expect(skills.get('source-test')?.metadata.sourceEpisodes).toEqual([
      'message-2',
    ]);
    controller.abort();
    expect(
      await call(second, 'createEntity', create('message-2')),
    ).toMatchObject({
      status: 'cancelled',
    });
  });
  it('rejects ambiguous matches across source groups and preserves every citation on failure', async () => {
    const { tools, entities } = await fixture();
    const entity = await entities.create(
      { title: 'Example', entityType: 'topic', loadOn: [], relatedTo: [] },
      {
        General: `Same fact.\n\nSources: [old](history:old)\n\nSame fact.\n\nSources: [new](history:${source})`,
      },
    );
    expect(
      await call(tools, 'updateEntity', {
        id: entity.frontmatter.Id,
        revision: entityRevision(entity),
        fields: {},
        operations: [
          {
            op: 'edit',
            section: 'General',
            oldText: 'Same fact.',
            text: 'Changed.',
          },
        ],
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(entities.get(entity.frontmatter.Id)).toEqual(entity);
  });

  it('rejects concurrent stale entity commits and aggregate size overflow', async () => {
    const { tools, entities } = await fixture();
    await call(tools, 'createEntity', create());
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    const input = {
      id: entity.frontmatter.Id,
      revision: entityRevision(entity),
      fields: {},
      operations: [
        {
          op: 'append',
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
    const current = entities.get(entity.frontmatter.Id);
    if (!current) throw new Error('Missing entity');
    expect(
      await call(tools, 'updateEntity', {
        ...input,
        revision: entityRevision(current),
        operations: [
          {
            op: 'append',
            section: 'General',
            text: 'x'.repeat(30_000),
            sourceIds: [source],
          },
          {
            op: 'append',
            section: 'General',
            text: 'y'.repeat(30_000),
            sourceIds: [source],
          },
        ],
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(entities.get(entity.frontmatter.Id)).toEqual(current);
  });

  it('covers ordered entity operations, citation removal and literal replacements', async () => {
    const { tools, entities } = await fixture();
    await call(tools, 'createEntity', create());
    const original = entities.list()[0];
    if (!original) throw new Error('Missing entity');
    const id = original.frontmatter.Id;
    const edit = async (operations: unknown[]) => {
      const current = entities.get(id);
      if (!current) throw new Error('Missing entity');
      await call(tools, 'readEntity', {
        id,
        sections: Object.keys(current.sections),
      });
      const result = await call(tools, 'updateEntity', {
        id,
        revision: entityRevision(current),
        fields: {},
        operations,
      });
      expect(result).toMatchObject({ status: 'updated' });
    };
    await edit([
      {
        op: 'append',
        section: '__proto__',
        text: 'Literal fact',
        sourceIds: [source],
        createIfMissing: true,
      },
    ]);
    await edit([
      {
        op: 'edit',
        section: '__proto__',
        oldText: 'Literal fact',
        text: '$& literal',
        sourceIds: [source],
        removeSourceIds: [source],
      },
    ]);
    expect(
      Object.entries(entities.get(id)?.sections ?? {}).find(
        ([name]) => name === '__proto__',
      )?.[1],
    ).toContain('$& literal');
    await edit([
      {
        op: 'move',
        section: '__proto__',
        oldText: '$& literal',
        destination: 'General',
      },
    ]);
    expect(Object.hasOwn(entities.get(id)?.sections ?? {}, '__proto__')).toBe(
      false,
    );
    await edit([
      {
        op: 'append',
        section: 'Details',
        text: 'detail',
        sourceIds: [source],
        createIfMissing: true,
      },
      { op: 'renameSection', section: 'Details', destination: 'Renamed' },
    ]);
    await edit([{ op: 'removeSection', section: 'Renamed' }]);
    expect(entities.get(id)?.sections.Renamed).toBeUndefined();
    await edit([
      {
        op: 'replace',
        section: 'General',
        text: 'Short',
        removeSourceIds: [source],
        sourceIds: [source],
      },
    ]);
    expect(entities.get(id)?.sections.General).toBe(
      `Short\n\nSources: [2026-11-12T14:00:00.000Z · slack](history:${source})`,
    );
  });

  it.each([
    { op: 'append', section: 'General', text: 'fact' },
    { op: 'append', section: 'Missing', text: 'fact', sourceIds: [source] },
    {
      op: 'append',
      section: 'General',
      text: 'fact',
      sourceIds: ['history:invented'],
    },
    {
      op: 'append',
      section: 'General',
      text: '## escape',
      sourceIds: [source],
    },
    {
      op: 'append',
      section: 'General',
      text: 'Sources: forged',
      sourceIds: [source],
    },
    {
      op: 'append',
      section: 'General',
      text: 'history:forged',
      sourceIds: [source],
    },
    { op: 'edit', section: 'General', oldText: 'owner', text: 'changed' },
    { op: 'edit', section: 'General', oldText: 'absent', text: 'changed' },
    {
      op: 'edit',
      section: 'General',
      oldText: 'Project owner owner',
      text: '',
    },
    { op: 'replace', section: 'General', text: '' },
    {
      op: 'replace',
      section: 'General',
      text: 'new',
      removeSourceIds: ['missing-id'],
    },
    {
      op: 'replace',
      section: 'General',
      text: 'new',
      removeSourceIds: ['history:unknown'],
    },
    { op: 'renameSection', section: 'General', destination: 'Other' },
    { op: 'renameSection', section: 'Detail', destination: 'General' },
    { op: 'removeSection', section: 'General' },
    { op: 'removeSection', section: 'Missing' },
    { op: 'move', section: 'Detail', oldText: 'detail', destination: 'Detail' },
    { op: 'move', section: 'Detail', oldText: 'det', destination: 'General' },
    {
      op: 'move',
      section: 'Detail',
      oldText: 'detail',
      destination: 'Missing',
    },
  ])('rejects invalid entity operation atomically: %j', async (operation) => {
    const { tools, entities } = await fixture();
    await call(tools, 'createEntity', {
      ...create(),
      sections: [
        {
          name: 'General',
          content: 'Project owner owner',
          sourceIds: [source],
        },
        { name: 'Detail', content: 'detail', sourceIds: [source] },
      ],
    });
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    expect(
      await call(tools, 'updateEntity', {
        id: entity.frontmatter.Id,
        revision: entityRevision(entity),
        fields: { title: 'Should not persist' },
        operations: [operation],
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(entities.get(entity.frontmatter.Id)).toEqual(entity);
  });

  it('applies skill body patches without rewriting unrelated content and rejects stale/ambiguous batches', async () => {
    const { tools, skills } = await fixture();
    const name = 'patch-workflow';
    await call(tools, 'createLearnedSkill', {
      name,
      description: 'Original',
      body: 'Keep this.\n\nChange this.',
      sourceIds: [source],
    });
    const patch = async (operations: unknown[], description?: string) => {
      const read = (await call(tools, 'readLearnedSkill', { name })) as {
        revision: string;
      };
      return call(tools, 'updateLearnedSkill', {
        name,
        revision: read.revision,
        sourceIds: [source],
        operations,
        ...(description ? { description } : {}),
      });
    };
    const stale = (await call(tools, 'readLearnedSkill', { name })) as {
      revision: string;
    };
    expect(
      await patch([
        { op: 'append', text: 'More.' },
        { op: 'edit', oldText: 'Change this.', text: '$& corrected.' },
      ]),
    ).toMatchObject({ status: 'updated' });
    expect(skills.get(name)?.body).toBe('Keep this.\n\n$& corrected.\n\nMore.');
    expect(skills.get(name)?.description).toBe('Original');
    expect(
      await call(tools, 'updateLearnedSkill', {
        name,
        revision: stale.revision,
        sourceIds: [source],
        operations: [],
      }),
    ).toMatchObject({ status: 'rejected' });
    const before = skills.get(name);
    expect(
      await patch([
        { op: 'append', text: 'Do not persist' },
        { op: 'edit', oldText: 'missing', text: '' },
      ]),
    ).toMatchObject({ status: 'rejected' });
    expect(skills.get(name)).toEqual(before);
    expect(
      await patch(
        [{ op: 'replace', text: 'repeat repeat' }],
        'New description',
      ),
    ).toMatchObject({ status: 'updated' });
    expect(
      await patch([{ op: 'edit', oldText: 'repeat', text: 'once' }]),
    ).toMatchObject({ status: 'rejected' });
    expect(
      await patch([{ op: 'edit', oldText: 'repeat repeat', text: '' }]),
    ).toMatchObject({ status: 'rejected' });
    expect(await patch([{ op: 'replace', text: '  ' }])).toMatchObject({
      status: 'rejected',
    });
    expect(
      await patch([{ op: 'edit', oldText: 'repeat repeat', text: 'Short.' }]),
    ).toMatchObject({ status: 'updated' });
    expect(skills.get(name)?.body).toBe('Short.');
    expect(skills.get(name)?.description).toBe('New description');
    expect(skills.get(name)?.metadata.sourceEpisodes).toEqual([source]);
    const read = (await call(tools, 'readLearnedSkill', { name })) as {
      revision: string;
    };
    const concurrent = {
      name,
      revision: read.revision,
      sourceIds: [source],
      operations: [{ op: 'append', text: 'Once.' }],
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
  it('edits, moves and compresses groups without losing old evidence, rejecting stale or partial writes', async () => {
    const { tools, entities } = await fixture();
    const oldSource = 'history:b2xk';
    const entity = await entities.create(
      { title: 'Alex Smith', entityType: 'person', loadOn: [], relatedTo: [] },
      { General: `Owns Atlas.\n\nSources: [January](${oldSource})` },
    );
    const id = entity.frontmatter.Id;
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
    await update([
      {
        op: 'append',
        section: 'General',
        text: 'Lives in Berlin.',
        sourceIds: [source],
      },
    ]);
    expect(entities.get(id)?.sections.General).toContain(
      `Sources: [January](${oldSource})`,
    );
    await update([
      {
        op: 'edit',
        section: 'General',
        oldText: 'Owns Atlas.',
        text: 'Previously owned Atlas.',
        sourceIds: [source],
      },
    ]);
    await update([
      {
        op: 'move',
        section: 'General',
        oldText: 'Previously owned Atlas.',
        destination: 'Projects',
        createIfMissing: true,
      },
    ]);
    expect(entities.get(id)?.sections.General).not.toContain(oldSource);
    expect(entities.get(id)?.sections.Projects).toContain(oldSource);
    await update([
      { op: 'renameSection', section: 'Projects', destination: 'Career' },
      { op: 'replace', section: 'Career', text: 'Former Atlas owner.' },
    ]);
    expect(entities.get(id)?.sections.Career).toContain(oldSource);
    const before = entities.get(id);
    expect(
      await update([
        {
          op: 'append',
          section: 'General',
          text: 'New fact.',
          sourceIds: [source],
        },
        { op: 'edit', section: 'General', oldText: 'missing', text: '' },
      ]),
    ).toMatchObject({ status: 'rejected' });
    expect(entities.get(id)).toEqual(before);
    expect(
      await call(tools, 'updateEntity', {
        id,
        revision: entityRevision(entity),
        fields: {},
        operations: [],
      }),
    ).toMatchObject({ status: 'rejected' });
    await update([
      {
        op: 'edit',
        section: 'Career',
        oldText: 'Former Atlas owner.',
        text: '',
      },
    ]);
    expect(entities.get(id)?.sections.Career).toBeUndefined();
    expect(
      await update([{ op: 'removeSection', section: 'General' }]),
    ).toMatchObject({ status: 'rejected' });
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
        General: 'Overview',
        Schedule: `${'padding '.repeat(60)}Launch 2027-03-10 ${'suffix '.repeat(100)}\n\nSources: [2026-11-12 · slack](history:${source})`,
      },
    );
    const title = await entities.create(
      {
        title: 'Launch plan',
        entityType: 'project',
        loadOn: [],
        relatedTo: [],
      },
      { General: 'Overview' },
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
    expect(results.entities.map(({ id }) => id)).toEqual([
      title.frontmatter.Id,
      detail.frontmatter.Id,
    ]);
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
    ).toMatchObject({ entities: [{ id: detail.frontmatter.Id }] });
    expect(
      await call(tools, 'listEntities', { query: '2026-11-12' }),
    ).toMatchObject({ entities: [] });
    expect(
      await call(tools, 'listEntities', { query: detail.frontmatter.Id }),
    ).toMatchObject({ entities: [] });
    for (let index = 0; index < 19; index++)
      await entities.create(
        {
          title: `Extra ${index}`,
          entityType: 'topic',
          loadOn: [],
          relatedTo: [],
        },
        { General: 'Overview' },
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
  it('writes validated citations with environmental timestamp/platform, rejects invented evidence', async () => {
    const { tools, entities } = await fixture();
    expect(
      await call(tools, 'createEntity', create('history:invented')),
    ).toMatchObject({ status: 'rejected' });
    await call(tools, 'createEntity', create());
    expect(entities.list()[0]?.sections.General).toContain(
      `[2026-11-12T14:00:00.000Z · slack](history:${source})`,
    );
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
    const input = {
      name: 'deploy-workflow',
      description: 'When deploying',
      body: 'Follow the specific workflow.',
      sourceIds: [source],
    };
    await call(tools, 'createLearnedSkill', input);
    expect(skills.get(input.name)?.body).toBe(input.body);
    expect(await call(tools, 'createLearnedSkill', input)).toMatchObject({
      status: 'rejected',
    });
    const read = (await call(tools, 'readLearnedSkill', {
      name: input.name,
    })) as { revision: string };
    await call(tools, 'updateLearnedSkill', {
      name: input.name,
      revision: read.revision,
      sourceIds: [source],
      operations: [{ op: 'replace', text: 'Updated workflow.' }],
    });
    expect(skills.get(input.name)?.body).toBe('Updated workflow.');
    await expect(
      call(tools, 'createLearnedSkill', { ...input, name: 'templates/escape' }),
    ).rejects.toThrow();
    expect(
      registry.list().every((skill) => skill.namespace === 'learning'),
    ).toBe(true);
    expect(tools.deleteLearnedSkill).toBeUndefined();
    expect(tools.recordRead).toBeUndefined();
  });
  it('rejects missing relation targets, preserves unrelated sections, and cancels writes', async () => {
    const { tools, entities, controller } = await fixture();
    await call(tools, 'createEntity', create());
    const entity = entities.list()[0];
    if (!entity) throw new Error('Missing entity');
    expect(
      await call(tools, 'updateEntity', {
        id: entity.frontmatter.Id,
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
      id: entity.frontmatter.Id,
      revision: entityRevision(entity),
      fields: {},
      operations: [
        {
          op: 'append',
          section: 'Details',
          text: 'More facts',
          sourceIds: [source],
          createIfMissing: true,
        },
      ],
    });
    expect(entities.get(entity.frontmatter.Id)?.sections.General).toBe(
      entity.sections.General,
    );
    controller.abort();
    expect(await call(tools, 'createEntity', create())).toMatchObject({
      status: 'cancelled',
    });
    expect(entities.list()).toHaveLength(1);
  });
});
