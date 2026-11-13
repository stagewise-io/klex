import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createEntityStore,
  entityFieldsSchema,
  loadMatcherSchema,
  renderEntity,
} from './entities';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'memory-entities-'));
  directories.push(directory);
  const store = createEntityStore(join(directory, 'entities'));
  await store.start();
  return { store, directory };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const fields = () =>
  entityFieldsSchema.parse({ title: 'Alex Smith', entityType: 'person' });

describe('factual entities', () => {
  it('persists separate identities with identical titles and reloads markdown', async () => {
    const { store, directory } = await fixture();
    const first = await store.create(fields(), {
      General: 'Engineer',
      Details: 'Project owner',
    });
    const second = await store.create(fields(), { General: 'Designer' });
    expect(first.frontmatter.Id).not.toBe(second.frontmatter.Id);
    expect(first.frontmatter).toMatchObject({
      TrustScore: 2,
      AuthorityScore: 5,
      LastReadAt: null,
      LoadOn: [{ type: 'contentPattern', pattern: 'Alex Smith' }],
    });
    const file = await readFile(
      join(directory, 'entities', 'person', `${first.frontmatter.Id}.md`),
      'utf8',
    );
    expect(file).toContain('## General');
    expect(file).toContain('FormatVersion: 2');
    expect(file).not.toContain('EntityType:');
    expect(first.entityType).toBe('person');
    const restored = createEntityStore(join(directory, 'entities'));
    await restored.start();
    expect(restored.list()).toHaveLength(2);
    expect(restored.get(first.frontmatter.Id)).toEqual(first);
  });
  it('protects dates and General, preserves sections and serializes concurrent updates', async () => {
    const { store } = await fixture();
    const original = await store.create(fields(), {
      General: 'Engineer',
      Details: 'Original',
    });
    const id = original.frontmatter.Id;
    await Promise.all([
      store.update(id, { title: 'Alex Jones' }, {}),
      store.update(id, {}, { Extra: 'More' }),
    ]);
    expect(store.get(id)?.sections).toEqual({
      General: 'Engineer',
      Details: 'Original',
      Extra: 'More',
    });
    expect(store.get(id)?.frontmatter.CreatedAt).toBe(
      original.frontmatter.CreatedAt,
    );
    expect(store.get(id)?.frontmatter.LastReadAt).toBeNull();
    await store.recordRead(id);
    expect(store.get(id)?.frontmatter.LastReadAt).toBeTruthy();
    await expect(store.update(id, {}, {}, ['General'])).rejects.toThrow(
      'General',
    );
    expect(() =>
      store.update(id, { CreatedAt: 'forged' } as never, {}),
    ).toThrow();
    expect(() => store.get('../outside')).toThrow();
    expect(() =>
      entityFieldsSchema.parse({ ...fields(), TrustScore: 5 }),
    ).toThrow();
  });
  it('includes General, loads requested sections, and strips canonical identifiers', async () => {
    const { store } = await fixture();
    const entity = await store.create(fields(), {
      General: 'Fact [2026-11-12 · slack](history:abc)',
      Details: 'Details',
    });
    expect(renderEntity(entity)).toContain('2026-11-12 · slack');
    expect(renderEntity(entity)).not.toContain('history:');
    expect(renderEntity(entity)).not.toContain('Details');
    expect(renderEntity(entity, ['Details'])).toContain('Details');
  });
  it('supports extensible ontology and all three matcher types', async () => {
    const { store } = await fixture();
    const entity = await store.create(
      {
        ...fields(),
        entityType: 'custom-domain-type',
        loadOn: [
          {
            type: 'pushNotificationMetadataPattern',
            conditions: [
              { path: 'metadata.userId', match: 'exact', value: 'U123' },
            ],
          },
          {
            type: 'toolCallPattern',
            mcpServer: 'slack',
            toolName: 'reply',
            arguments: [],
          },
        ],
      },
      { General: 'Fact' },
    );
    expect(entity.frontmatter.LoadOn).toHaveLength(3);
    expect(() =>
      loadMatcherSchema.parse({ type: 'toolCallPattern' }),
    ).toThrow();
  });
  it('preserves matcher and relation collections when a patch omits them', async () => {
    const { store } = await fixture();
    const target = await store.create(fields(), { General: 'Colleague' });
    const entity = await store.create(
      {
        ...fields(),
        loadOn: [{ type: 'contentPattern', pattern: 'deployment team' }],
        relatedTo: [
          {
            target: { kind: 'entity', id: target.frontmatter.Id },
            strength: 75,
            relationship: 'colleague',
          },
        ],
      },
      { General: 'Engineer' },
    );
    const updated = await store.update(
      entity.frontmatter.Id,
      { title: 'Alex Jones' },
      { Details: 'More' },
    );
    expect(updated.frontmatter.RelatedTo).toEqual(entity.frontmatter.RelatedTo);
    expect(updated.frontmatter.LoadOn).toEqual([
      { type: 'contentPattern', pattern: 'Alex Jones' },
      { type: 'contentPattern', pattern: 'deployment team' },
    ]);
    const cleared = await store.update(
      entity.frontmatter.Id,
      { loadOn: [], relatedTo: [] },
      {},
    );
    expect(cleared.frontmatter.RelatedTo).toEqual([]);
    expect(cleared.frontmatter.LoadOn).toEqual([
      { type: 'contentPattern', pattern: 'Alex Jones' },
    ]);
  });
  it('moves ontology folders while preserving identity, dates, sources and reloadability', async () => {
    const { store, directory } = await fixture();
    const original = await store.create(fields(), {
      General: 'Fact\n\nSources: [source](history:abc)',
    });
    const id = original.frontmatter.Id;
    const moved = await store.update(id, { entityType: 'project' }, {});
    expect(moved.entityType).toBe('project');
    expect(moved.frontmatter.Id).toBe(id);
    expect(moved.frontmatter.CreatedAt).toBe(original.frontmatter.CreatedAt);
    expect(moved.sections).toEqual(original.sections);
    await expect(
      readFile(join(directory, 'entities', 'person', `${id}.md`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = createEntityStore(join(directory, 'entities'));
    await restored.start();
    expect(restored.get(id)).toEqual(moved);
    await mkdir(join(directory, 'entities', 'topic'));
    await rename(
      join(directory, 'entities', 'project', `${id}.md`),
      join(directory, 'entities', 'topic', `${id}.md`),
    );
    const manuallyMoved = createEntityStore(join(directory, 'entities'));
    await manuallyMoved.start();
    expect(manuallyMoved.get(id)?.entityType).toBe('topic');
    for (const entityType of [
      '../escape',
      'Person',
      'nested/person',
      '.',
      '',
    ]) {
      expect(() => store.update(id, { entityType }, {})).toThrow();
    }
  });
  it('converts flat v1 notes and resumes notes already moved before conversion', async () => {
    const { store, directory } = await fixture();
    const original = await store.create(fields(), {
      General: 'Fact\n\nSources: [source](history:abc)',
    });
    const file = join(
      directory,
      'entities',
      'person',
      `${original.frontmatter.Id}.md`,
    );
    const current = await readFile(file, 'utf8');
    const legacy = current.replace(
      'FormatVersion: 2',
      'FormatVersion: 1\nEntityType: person',
    );
    const flat = join(directory, 'entities', `${original.frontmatter.Id}.md`);
    await rm(file);
    await writeFile(flat, legacy);
    const migrated = createEntityStore(join(directory, 'entities'));
    await migrated.start();
    expect(migrated.get(original.frontmatter.Id)).toEqual(original);
    expect(await readFile(file, 'utf8')).toBe(current);
    await expect(readFile(flat)).rejects.toMatchObject({ code: 'ENOENT' });
    const again = createEntityStore(join(directory, 'entities'));
    await again.start();
    expect(await readFile(file, 'utf8')).toBe(current);
    await writeFile(file, legacy);
    await createEntityStore(join(directory, 'entities')).start();
    expect(await readFile(file, 'utf8')).toBe(current);
  });
  it('validates all documents before conversion and rejects duplicates and newer formats unchanged', async () => {
    const { store, directory } = await fixture();
    const entity = await store.create(fields(), { General: 'Fact' });
    const file = join(
      directory,
      'entities',
      'person',
      `${entity.frontmatter.Id}.md`,
    );
    const current = await readFile(file, 'utf8');
    const legacy = current.replace(
      'FormatVersion: 2',
      'FormatVersion: 1\nEntityType: person',
    );
    const flat = join(directory, 'entities', `${entity.frontmatter.Id}.md`);
    await writeFile(flat, legacy);
    await expect(
      createEntityStore(join(directory, 'entities')).start(),
    ).rejects.toThrow('Invalid entity');
    expect(await readFile(flat, 'utf8')).toBe(legacy);
    expect(await readFile(file, 'utf8')).toBe(current);
    await rm(flat);
    const newer = current.replace('FormatVersion: 2', 'FormatVersion: 3');
    await writeFile(file, newer);
    await expect(
      createEntityStore(join(directory, 'entities')).start(),
    ).rejects.toThrow('Invalid entity');
    expect(await readFile(file, 'utf8')).toBe(newer);
    await writeFile(file, current);
    await symlink(
      join(directory, 'entities', 'person'),
      join(directory, 'entities', 'project'),
    );
    await expect(
      createEntityStore(join(directory, 'entities')).start(),
    ).rejects.toThrow('plain directory');
  });
  it('rejects symlinked entity roots', async () => {
    const { directory } = await fixture();
    const linked = join(directory, 'linked');
    await symlink(join(directory, 'entities'), linked);
    await expect(createEntityStore(linked).start()).rejects.toThrow(
      'plain directory',
    );
  });
});
