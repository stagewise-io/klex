import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createEntityStore,
  type EntityStoreOptions,
  entityFieldsSchema,
  entityIdSchema,
  entityRevision,
  type FlatConversionSummary,
  loadMatcherSchema,
  normalizeTag,
  normalizeTitle,
  planFlatTitles,
  RELATION_INVERSES,
  type Relation,
  renderEntity,
  tagSchema,
} from './entities';
import { type Fact, formatFacts, parseFacts } from './facts';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'memory-entities-'));
  directories.push(directory);
  const root = join(directory, 'entities');
  const store = createEntityStore(root);
  await store.start();
  return { store, root };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const fields = () =>
  entityFieldsSchema.parse({ title: 'Alex Smith', tags: ['people'] });
const fact = (text: string, id = 'abc'): Fact => ({
  text,
  sources: [{ label: '2026-11-12 · slack', id }],
  history: [],
});
const sections = (text = 'Engineer') => ({ General: [fact(text)] });
const relation = (
  id: string,
  relationship: Relation['relationship'] = 'relatedTo',
): Relation => ({ target: { kind: 'entity', id }, relationship });
const skill = (id = 'learning/deploy') => ({
  target: { kind: 'skill' as const, id },
  relationship: 'relatedTo' as const,
});
const legacyId = '11111111-1111-4111-8111-111111111111';
// Literal released document contracts; independent of the current serializer.
const legacyNote = (
  version = 3,
  title = 'Alex Smith',
  extra = '',
  body = 'Engineer',
) =>
  `---\nFormatVersion: ${version}\n${version < 3 ? `Id: ${legacyId}\n` : ''}${version === 1 ? 'EntityType: person\n' : ''}Title: ${title}\nCreatedAt: 2026-11-12T00:00:00.000Z\nLastUpdatedAt: 2026-11-12T00:00:00.000Z\nLastReadAt: null\nLinkedIdentities: []\nLoadOn: []\nRelatedTo: []\nTrustScore: 2\nAuthorityScore: 5\n${extra}---\n\n## General\n\n- ${body} [old](history:abc)\n`;
// Released v0.38.0 contract (format 5).
const v5Note = (links: readonly string[] = [], body = 'Engineer') =>
  `---\nFormatVersion: 5\nCreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities: []\nLoadOn: []\n${links.length ? `RelatedTo:\n${links.map((link) => `  - "${link}"\n`).join('')}` : 'RelatedTo: []\n'}TrustScore: 2\nAuthorityScore: 5\n---\n\n## General\n\n- ${body} [old](history:abc)\n`;
// Main's format 6 contract (commit 8054c512): per-predicate plain link lists.
const v6Note = (
  relations: Record<string, readonly string[]> = {},
  body = 'Engineer',
) =>
  `---\nFormatVersion: 6\nCreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities: []\nLoadOn: []\nTrustScore: 2\nAuthorityScore: 5\n${Object.entries(
    relations,
  )
    .map(
      ([type, links]) =>
        `${type}:\n${links.map((link) => `  - "${link}"\n`).join('')}`,
    )
    .join('')}---\n\n## General\n\n- ${body} [old](history:abc)\n`;
async function seed(root: string, path: string, content: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}
/** Memory-writer store: never converts. */
async function restart(root: string) {
  const store = createEntityStore(root);
  await store.start();
  return store;
}
/** Application startup migration store. */
async function migrate(root: string, options: EntityStoreOptions = {}) {
  const store = createEntityStore(root, { migrate: true, ...options });
  await store.start();
  return store;
}

describe('flat titled entities', () => {
  it('converts released event matcher names through journaled startup without changing behavior or facts', async () => {
    const { root } = await fixture();
    const old = legacyNote(3).replace(
      'LoadOn: []',
      'LoadOn:\n  - type: pushNotificationMetadataPattern\n    server: slack\n    conditions:\n      - path: conversationId\n        match: exact\n        value: C1',
    );
    const file = await seed(root, `person/${legacyId}.md`, old);
    const converted = await migrate(root);
    const value = converted.get('Alex Smith');
    expect(value?.frontmatter.LoadOn).toEqual([
      {
        type: 'eventDataPattern',
        server: 'slack',
        conditions: [{ path: 'conversationId', match: 'exact', value: 'C1' }],
      },
    ]);
    const destination = join(root, 'Alex Smith.md');
    const bytes = await readFile(destination, 'utf8');
    expect(bytes).toContain('Engineer [old](history:abc)');
    expect(bytes).not.toContain('pushNotificationMetadataPattern');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await restart(root);
    expect(await readFile(destination, 'utf8')).toBe(bytes);
    // Already-flat format-7 documents need the matcher-only conversion too.
    await writeFile(
      destination,
      bytes.replace('eventDataPattern', 'pushNotificationMetadataPattern'),
    );
    expect((await migrate(root)).get('Alex Smith')?.frontmatter.LoadOn).toEqual(
      value?.frontmatter.LoadOn,
    );
    expect(await readFile(destination, 'utf8')).toBe(bytes);
  });

  it('queues immutable snapshots behind managed creation and rename', async () => {
    const { store } = await fixture();
    const creation = store.create(fields(), sections());
    const firstRead = store.snapshot();
    const created = await creation;
    const first = await firstRead;
    expect(first.map((entity) => entity.id)).toEqual([created.id]);
    const rename = store.update(created.id, { title: 'Renamed' }, {});
    const nextRead = store.snapshot();
    const renamed = await rename;
    expect((await nextRead).map((entity) => entity.id)).toEqual([renamed.id]);
    expect(first[0]!.id).toBe('Alex Smith');
    first[0]!.sections.General = [];
    expect((await store.snapshot())[0]!.sections.General).toHaveLength(1);
  });
  it('uses the title as filename at the root, with Tags and no title frontmatter', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    expect(entity.id).toBe('Alex Smith');
    expect(entity.frontmatter.Tags).toEqual(['people']);
    expect(await readdir(root)).toEqual(['Alex Smith.md']);
    const content = await readFile(join(root, 'Alex Smith.md'), 'utf8');
    expect(
      content.startsWith('---\nFormatVersion: 7\nTags:\n  - people\n'),
    ).toBe(true);
    expect(content).not.toMatch(/^(Title|Id|EntityType|MergedFrom):/m);
    expect((await restart(root)).get(entity.id)).toEqual(entity);
    expect(store.conversion()).toBeNull();
  });
  it('defines involutive inverses for every curated predicate', () => {
    for (const [predicate, inverse] of Object.entries(RELATION_INVERSES)) {
      expect(RELATION_INVERSES[inverse]).toBe(predicate);
    }
  });
  it('validates and normalizes tags; requires at least one and deduplicates', async () => {
    for (const tag of [
      'people',
      'people/coworkers',
      'work-items/issues',
      'a/b/c/d',
    ])
      expect(tagSchema.safeParse(tag).success).toBe(true);
    for (const tag of [
      'People',
      'people/',
      'a//b',
      '-people',
      'people_x',
      'a/b/c/d/e',
      '../people',
      'x'.repeat(101),
    ])
      expect(tagSchema.safeParse(tag).success).toBe(false);
    expect(normalizeTag('project/stagewise-io')).toBe('project/stagewise-io');
    expect(normalizeTag('Project/Stage Wise_IO')).toBe('project/stage-wise-io');
    expect(normalizeTag('a/b/c/d/e')).toBe('a/b/c/d');
    const { store } = await fixture();
    expect(() => store.create({ ...fields(), tags: [] }, sections())).toThrow(
      '>=1',
    );
    const entity = await store.create(
      { ...fields(), tags: ['people', 'people/coworkers', 'people'] },
      sections(),
    );
    expect(entity.frontmatter.Tags).toEqual(['people', 'people/coworkers']);
    expect(() => store.update(entity.id, { tags: [] }, {})).toThrow('>=1');
    const retagged = await store.update(entity.id, { tags: ['teams'] }, {});
    expect(retagged.frontmatter.Tags).toEqual(['teams']);
    expect((await store.update(entity.id, {}, {})).frontmatter.Tags).toEqual([
      'teams',
    ]);
  });
  it('rejects duplicate titles across all tags, ignoring case, concurrently and after restart', async () => {
    const { store, root } = await fixture();
    const results = await Promise.allSettled([
      store.create(fields(), sections()),
      store.create({ ...fields(), title: 'alex smith' }, sections()),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    await expect(
      (await restart(root)).create(fields(), sections()),
    ).rejects.toThrow('already used by "Alex Smith"');
    await expect(
      store.create({ ...fields(), tags: ['projects'] }, sections()),
    ).rejects.toThrow('(company)');
    const qualified = await store.create(
      { ...fields(), title: 'Alex Smith (Acme)', tags: ['people'] },
      sections(),
    );
    expect(qualified.id).toBe('Alex Smith (Acme)');
    expect(store.get('alex smith')?.id).toBe('Alex Smith');
  });
  it('normalizes unsafe titles to one file name while leaving spelling to the writer', async () => {
    const { store } = await fixture();
    expect(normalizeTitle(' .. acme/web: API?  .. ')).toBe('acme web API');
    expect(normalizeTitle('CON')).toBe('_CON');
    expect(normalizeTitle('e\u0301e')).toBe('ée');
    const entity = await store.create(
      { ...fields(), title: 'acme/web: API?' },
      sections(),
    );
    expect(entity.id).toBe('acme web API');
    for (const id of [
      '../escape',
      'person/Name',
      '.',
      'Name.md',
      'Bad#Name',
      'a\\b',
      ' padded',
    ])
      expect(entityIdSchema.safeParse(id).success).toBe(false);
    for (const title of ['///', '..', 'x', 'note.md', '???', 'a'.repeat(101)])
      await expect(
        Promise.resolve().then(() =>
          store.create({ ...fields(), title }, sections()),
        ),
      ).rejects.toThrow();
    expect(store.list()).toHaveLength(1);
  });
  it('preserves different predicates to one target and rejects unknown frontmatter predicates', async () => {
    const { root, store } = await fixture();
    const entity = await store.create(
      {
        ...fields(),
        relatedTo: [
          relation('Klex'),
          { ...relation('Klex'), relationship: 'uses' },
          relation('Klex'),
        ],
      },
      sections(),
    );
    expect(entity.frontmatter.RelatedTo).toHaveLength(2);
    const file = join(root, `${entity.id}.md`);
    const original = await readFile(file, 'utf8');
    expect(
      (await restart(root)).get(entity.id)?.frontmatter.RelatedTo,
    ).toHaveLength(2);
    const invalid = original.replace('relatedTo:', 'belongsTo:');
    await writeFile(file, invalid);
    await expect(restart(root)).rejects.toThrow('Invalid entity');
    expect(await readFile(file, 'utf8')).toBe(invalid);
  });
  it('stores relations as plain Obsidian links and rejects labels and folder targets', async () => {
    const { store, root } = await fixture();
    await store.create({ ...fields(), title: 'Lead Person' }, sections('Lead'));
    const relations = [
      relation('Lead Person', 'reportsTo'),
      { ...skill(), relationship: 'uses' as const },
    ];
    const entity = await store.create(
      { ...fields(), relatedTo: relations },
      sections(),
    );
    const file = join(root, `${entity.id}.md`);
    const content = await readFile(file, 'utf8');
    expect(content).toContain(
      'reportsTo:\n  - "[[Lead Person]]"\nuses:\n  - "[[learning/deploy/SKILL.md]]"\n',
    );
    expect((await restart(root)).get(entity.id)).toEqual(entity);
    for (const link of [
      '[[Lead Person|reports to]]',
      '[[person/Lead Person]]',
    ]) {
      await writeFile(file, content.replace('[[Lead Person]]', link));
      await expect(restart(root)).rejects.toThrow('Invalid entity');
    }
    await writeFile(file, content);
    expect(() =>
      entityFieldsSchema.parse({
        ...fields(),
        relatedTo: [{ ...relations[0], relationship: 'a|b' }],
      }),
    ).toThrow();
  });
  it('rejects relation strength and arbitrary predicates in current tool fields', () => {
    expect(() =>
      entityFieldsSchema.parse({
        ...fields(),
        relatedTo: [{ ...relation('Klex'), strength: 80 }],
      }),
    ).toThrow();
    for (const relationship of [
      'uses protocol (80)',
      'works on',
      'belongsTo',
      'Uses',
    ])
      expect(() =>
        entityFieldsSchema.parse({
          ...fields(),
          relatedTo: [{ ...relation('Klex'), relationship }],
        }),
      ).toThrow();
  });
  it('renames by repointing relations on both sides but never fact text', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const peer = await store.create(
      {
        title: 'Sam Lee',
        tags: ['people'],
        relatedTo: [relation(entity.id, 'worksFor')],
      },
      {
        General: [
          {
            ...fact(`Works with [[${entity.id}]] and ${entity.id}`),
            history: [
              {
                text: `Met ${entity.id}.`,
                sources: [{ label: entity.id, id: 'evidence-id' }],
              },
            ],
          },
        ],
      },
    );
    await store.mutateRelations(entity.id, (relations) => [
      ...relations,
      relation(peer.id, 'employs'),
    ]);
    const before = store.get(peer.id);
    const moved = await store.update(entity.id, { title: 'Alex Jones' }, {});
    expect(moved.id).toBe('Alex Jones');
    expect(moved.frontmatter.Tags).toEqual(['people']);
    expect(store.get(entity.id)).toBeNull();
    expect(moved.frontmatter.CreatedAt).toBe(entity.frontmatter.CreatedAt);
    expect(moved.sections).toEqual(entity.sections);
    expect(moved.frontmatter.RelatedTo).toEqual([relation(peer.id, 'employs')]);
    await expect(readFile(join(root, `${entity.id}.md`))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    const restored = await restart(root);
    expect(restored.get(moved.id)).toEqual(moved);
    const changed = restored.get(peer.id);
    expect(changed?.frontmatter.RelatedTo).toEqual([
      relation(moved.id, 'worksFor'),
    ]);
    expect(changed?.sections).toEqual(before?.sections);
    expect(await readdir(root)).not.toContain('.moves.json');
  });
  it('supports case-only renames without duplicate directory entries', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const updated = await store.update(entity.id, { title: 'ALEX SMITH' }, {});
    expect(await readdir(root)).toEqual(['ALEX SMITH.md']);
    expect((await restart(root)).get(updated.id)).toEqual(updated);
  });
  it('rejects rename collisions without modifying either entity', async () => {
    const { store } = await fixture();
    const first = await store.create(fields(), sections());
    const second = await store.create(
      { ...fields(), title: 'Other Person' },
      sections(),
    );
    await expect(
      store.update(second.id, { title: 'alex smith' }, {}),
    ).rejects.toThrow('already used by');
    expect(store.get(first.id)).toEqual(first);
    expect(store.get(second.id)).toEqual(second);
  });
  it('preserves omitted collections, dates and sections, rejects stale writes and protects General', async () => {
    const { store } = await fixture();
    const identity = { server: 'slack', match: { user: 'U1' } };
    const original = await store.create(
      {
        ...fields(),
        linkedIdentities: [identity],
        loadOn: [{ type: 'contentPattern', pattern: 'deployment team' }],
      },
      sections(),
    );
    const results = await Promise.allSettled([
      store.update(
        original.id,
        {},
        { Details: [fact('More')] },
        [],
        entityRevision(original),
      ),
      store.update(original.id, {}, {}, [], entityRevision(original)),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const updated = store.get(original.id);
    if (!updated) throw new Error('Missing entity');
    expect(updated.frontmatter.LinkedIdentities).toEqual([identity]);
    expect(updated.frontmatter.LoadOn).toEqual(original.frontmatter.LoadOn);
    expect(updated.frontmatter.CreatedAt).toBe(original.frontmatter.CreatedAt);
    expect(updated.frontmatter.Tags).toEqual(['people']);
    expect(updated.sections.Details).toEqual([fact('More')]);
    await store.recordRead(original.id);
    expect(store.get(original.id)?.frontmatter.LastReadAt).toBeTruthy();
    await expect(
      store.update(original.id, {}, {}, ['General']),
    ).rejects.toThrow('General');
    expect(() =>
      store.update(original.id, { CreatedAt: 'forged' } as never, {}),
    ).toThrow();
    const cleared = await store.update(
      original.id,
      { linkedIdentities: [], loadOn: [], relatedTo: [] },
      {},
    );
    expect(cleared.frontmatter.LoadOn).toEqual([]);
    expect(cleared.frontmatter.LinkedIdentities).toEqual([]);
  });
  it('keeps fact history on disk but renders only current facts and requested detail', async () => {
    const { store, root } = await fixture();
    const general = {
      ...fact('Lives in Berlin', 'new'),
      history: [
        { text: 'Lives in Paris', sources: [{ label: 'old', id: 'old' }] },
      ],
    };
    expect(parseFacts(formatFacts([general]))).toEqual([general]);
    const identity = { server: 'slack', match: { user: 'U1' } };
    const entity = await store.create(
      {
        ...fields(),
        linkedIdentities: [identity],
        loadOn: [
          { type: 'contentPattern', pattern: 'alex smith' },
          {
            type: 'eventDataPattern',
            server: 'slack',
            conditions: [{ path: 'user', match: 'exact', value: 'U1' }],
          },
        ],
      },
      { General: [general], Details: [fact('Details')] },
    );
    expect(entity.frontmatter.LoadOn).toEqual([
      { type: 'contentPattern', pattern: 'alex smith' },
    ]);
    expect((await restart(root)).get(entity.id)?.frontmatter.LoadOn).toEqual(
      entity.frontmatter.LoadOn,
    );
    expect(renderEntity(entity)).toBe(
      '# Alex Smith\n\nIDs: slack user=U1\n\n## General\n- Lives in Berlin',
    );
    expect(renderEntity(entity, ['Details'])).toContain('- Details');
    expect((await restart(root)).get(entity.id)?.sections.General).toEqual([
      general,
    ]);
    await expect(
      store.create(
        { ...fields(), title: 'Other Person', linkedIdentities: [identity] },
        sections(),
      ),
    ).rejects.toThrow('already belongs');
  });
  it('validates extensible tags and matcher conditions', () => {
    for (const condition of [
      { path: 'user', match: 'fuzzy', value: 'U1' },
      { path: 'user', match: 'regex', value: '(' },
      { path: 'user', match: 'glob', value: 5 },
    ])
      expect(() =>
        loadMatcherSchema.parse({
          type: 'eventDataPattern',
          server: 'slack',
          conditions: [condition],
        }),
      ).toThrow();
    expect(
      entityFieldsSchema.parse({
        title: 'Example',
        tags: ['custom-domain-types/nested'],
        loadOn: [
          { type: 'toolCallPattern', mcpServer: 'slack', arguments: [] },
        ],
      }).tags,
    ).toEqual(['custom-domain-types/nested']);
  });
  it('merges facts, identities, tags and links; repoints relations, not prose; titles can be reused', async () => {
    const { store, root } = await fixture();
    const keep = await store.create(fields(), sections());
    const drop = await store.create(
      {
        ...fields(),
        title: 'Alex S',
        tags: ['people/coworkers'],
        linkedIdentities: [{ server: 'slack', match: { user: 'U1' } }],
      },
      { General: [fact('Engineer', 'other'), fact('Owns billing')] },
    );
    const peer = await store.create(
      {
        title: 'Sam Lee',
        tags: ['people'],
        relatedTo: [relation(keep.id), relation(drop.id)],
      },
      sections(`Met ${drop.id}`),
    );
    await expect(
      store.merge(keep.id, drop.id, 'stale', entityRevision(drop)),
    ).rejects.toThrow('read both');
    const merging = store.merge(
      keep.id,
      drop.id,
      entityRevision(keep),
      entityRevision(drop),
    );
    const captured = store.snapshot();
    const merged = await merging;
    const snapshot = await captured;
    expect(snapshot.some((item) => item.id === drop.id)).toBe(false);
    expect(snapshot.find((item) => item.id === keep.id)?.sections).toEqual(
      merged.sections,
    );
    expect(merged.sections.General?.map(({ text }) => text)).toEqual([
      'Engineer',
      'Owns billing',
    ]);
    expect(merged.sections.General?.[0]?.sources.map(({ id }) => id)).toEqual([
      'abc',
      'other',
    ]);
    expect(merged.frontmatter.Tags).toEqual(['people', 'people/coworkers']);
    expect(merged.frontmatter.LinkedIdentities).toHaveLength(1);
    expect(merged.frontmatter).not.toHaveProperty('MergedFrom');
    const restored = await restart(root);
    expect(restored.get(drop.id)).toBeNull();
    expect(restored.get(peer.id)?.frontmatter.RelatedTo).toEqual([
      relation(keep.id),
    ]);
    expect(restored.get(peer.id)?.sections.General?.[0]?.text).toBe(
      `Met ${drop.id}`,
    );
    await expect(restored.update(drop.id, {}, {})).rejects.toThrow(
      'Unknown entity',
    );
    expect(
      (await restored.create({ ...fields(), title: drop.id }, sections())).id,
    ).toBe(drop.id);
  });
  it('replays final snapshots when interrupted after source removal or partial writes', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const oldContent = await readFile(join(root, `${entity.id}.md`), 'utf8');
    const journal = {
      moves: [{ from: entity.id, to: 'New Name', path: `${entity.id}.md` }],
      documents: [{ id: 'New Name', content: oldContent }],
    };
    await writeFile(join(root, '.moves.json'), JSON.stringify(journal));
    await rm(join(root, `${entity.id}.md`));
    const recovered = await restart(root);
    expect(recovered.get('New Name')?.sections).toEqual(entity.sections);
    expect(recovered.get(entity.id)).toBeNull();
    // Replaying the same journal after a complete write is also safe.
    await writeFile(join(root, '.moves.json'), JSON.stringify(journal));
    expect((await restart(root)).get('New Name')).toEqual(
      recovered.get('New Name'),
    );
  });
  it('journals a failed rename and completes it on restart', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    // A non-empty directory where the renamed file must go blocks the write.
    await mkdir(join(root, 'New Name.md'));
    await writeFile(join(root, 'New Name.md', 'blocker'), '');
    await expect(
      store.update(entity.id, { title: 'New Name' }, {}),
    ).rejects.toThrow('restart');
    await expect(
      store.create({ ...fields(), title: 'Other Person' }, sections()),
    ).rejects.toThrow('restart');
    await rm(join(root, 'New Name.md'), { recursive: true });
    const recovered = await restart(root);
    expect(recovered.get('New Name')?.sections).toEqual(entity.sections);
    expect(recovered.get(entity.id)).toBeNull();
    expect(await readdir(root)).toEqual(['New Name.md']);
  });
  it('rejects symlinked roots, folders and journal paths before deleting sources', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const linked = `${root}-linked`;
    directories.push(linked);
    await symlink(root, linked);
    await expect(restart(linked)).rejects.toThrow('plain directory');
    const outside = join(root, '..', 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'person'));
    await expect(restart(root)).rejects.toThrow('plain directory');
    const content = await readFile(join(root, `${entity.id}.md`), 'utf8');
    await writeFile(
      join(root, '.moves.json'),
      JSON.stringify({
        moves: [
          {
            from: 'person/Alex Smith',
            to: 'Other',
            path: 'person/Alex Smith.md',
          },
        ],
        documents: [{ id: 'Other', content }],
      }),
    );
    await expect(restart(root)).rejects.toThrow('plain directory');
    expect(await readFile(join(root, `${entity.id}.md`), 'utf8')).toBe(content);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('planFlatTitles', () => {
  it('keeps unique leaves and qualifies every member of a clash, cascading top-level → path → number', () => {
    expect(
      planFlatTitles(
        [
          { folder: 'company', leaf: 'Mercury' },
          { folder: 'element', leaf: 'mercury' },
          { folder: 'person', leaf: 'Ada' },
          { folder: 'project/stagewise-io', leaf: 'klex' },
          { folder: 'project/other', leaf: 'Klex' },
          { folder: 'team', leaf: 'Billing' },
          { folder: 'team', leaf: 'billing' },
          { folder: 'event', leaf: 'Launch (2026)' },
          { folder: 'project', leaf: 'Launch (2026)' },
        ],
        ['Ada'],
      ),
    ).toEqual({
      titles: [
        'Mercury (company)',
        'mercury (element)',
        'Ada (person)',
        'klex (project stagewise-io)',
        'Klex (project other)',
        'Billing (team)',
        'billing (team 2)',
        'Launch (2026) (event)',
        'Launch (2026) (project)',
      ],
      collisions: [
        ['Mercury (company)', 'mercury (element)'],
        ['Ada (person)'],
        ['klex (project stagewise-io)', 'Klex (project other)'],
        ['Billing (team)', 'billing (team 2)'],
        ['Launch (2026) (event)', 'Launch (2026) (project)'],
      ],
    });
  });
  it('trims long titles so the qualified title stays within limits', () => {
    const leaf = 'a'.repeat(100);
    const { titles } = planFlatTitles(
      [
        { folder: 'person', leaf },
        { folder: 'project', leaf },
      ],
      [],
    );
    for (const title of titles) {
      expect(title.length).toBeLessThanOrEqual(100);
      expect(entityIdSchema.safeParse(title).success).toBe(true);
    }
    expect(titles[0]?.endsWith(' (person)')).toBe(true);
  });
  it('keeps the number in long numeric fallbacks instead of retrying forever', () => {
    const folder = `team/${'x'.repeat(70)}`;
    const { titles } = planFlatTitles(
      [
        { folder, leaf: 'Billing' },
        { folder, leaf: 'billing' },
        { folder, leaf: 'BILLING' },
      ],
      [],
    );
    expect(new Set(titles.map((title) => title.toLowerCase())).size).toBe(3);
    expect(titles[1]?.endsWith(' 2)')).toBe(true);
    expect(titles[2]?.endsWith(' 3)')).toBe(true);
    for (const title of titles)
      expect(entityIdSchema.safeParse(title).success).toBe(true);
  });
});

describe('startup flattening', () => {
  it('drops dangling links on already-flat notes too and runs the pre-write hook first', async () => {
    const { root } = await fixture();
    const current = await createEntityStore(root);
    await current.start();
    await current.create(
      {
        ...entityFieldsSchema.parse({ title: 'Klex', tags: ['projects'] }),
        relatedTo: [relation('Ghost')],
      },
      sections(),
    );
    await seed(root, 'person/Ada.md', v6Note());
    const order: string[] = [];
    let planned: FlatConversionSummary | undefined;
    await migrate(root, {
      onConversionPlanned: (summary) => {
        planned = summary;
        order.push('planned');
      },
      beforeConversionWrite: async () => {
        order.push(existsSync(join(root, 'person/Ada.md')) ? 'hook' : 'late');
      },
    });
    expect(order).toEqual(['planned', 'hook']);
    expect(planned?.droppedLinks).toContainEqual({
      entity: 'Klex',
      target: 'Ghost',
    });
    expect((await restart(root)).get('Klex')?.frontmatter.RelatedTo).toEqual(
      [],
    );
  });
  it('converts format 6 folders to root titles with literal folder tags, qualified clashes and paired predicates', async () => {
    const { root } = await fixture();
    await seed(
      root,
      'person/Ada Lovelace.md',
      v6Note(
        {
          worksFor: ['[[organization/Acme]]'],
          uses: ['[[organization/Ghost]]'],
          relatedTo: ['[[company/Mercury]]', '[[learning/deploy/SKILL.md]]'],
        },
        'Joined organization/Acme in 2020; see organization/Acme-old',
      ),
    );
    await seed(
      root,
      'organization/Acme.md',
      v6Note({ employs: ['[[person/Ada Lovelace]]'] }),
    );
    await seed(root, 'project/stagewise-io/klex.md', v6Note());
    await seed(root, 'element/mercury.md', v6Note());
    const company = await seed(root, 'company/Mercury.md', v6Note());
    await seed(root, '.obsidian/workspace.json', '{"open":"person"}');
    await seed(root, '.obsidian/templates/note.md', 'not an entity');
    let planned: FlatConversionSummary | undefined;
    const store = await migrate(root, {
      onConversionPlanned: (summary) => {
        // Reported before anything is written.
        expect(existsSync(company)).toBe(true);
        planned = summary;
      },
    });
    expect(planned).toEqual(store.conversion());
    expect(planned).toMatchObject({
      moved: 5,
      collisions: [['Mercury (company)', 'mercury (element)']],
      droppedLinks: [{ entity: 'Ada Lovelace', target: 'organization/Ghost' }],
      addedInverses: 1,
      dryRun: false,
    });
    expect((await readdir(root)).sort()).toEqual([
      '.obsidian',
      'Acme.md',
      'Ada Lovelace.md',
      'Mercury (company).md',
      'klex.md',
      'mercury (element).md',
    ]);
    expect(await readFile(join(root, '.obsidian/workspace.json'), 'utf8')).toBe(
      '{"open":"person"}',
    );
    expect(
      await readFile(join(root, '.obsidian/templates/note.md'), 'utf8'),
    ).toBe('not an entity');
    const ada = store.get('Ada Lovelace');
    expect(ada?.frontmatter.Tags).toEqual(['person']);
    expect(ada?.frontmatter.RelatedTo).toEqual([
      relation('Acme', 'worksFor'),
      relation('Mercury (company)'),
      skill(),
    ]);
    expect(ada?.sections.General?.[0]?.text).toBe(
      'Joined Acme in 2020; see organization/Acme-old',
    );
    expect(store.get('Acme')?.frontmatter.RelatedTo).toEqual([
      relation('Ada Lovelace', 'employs'),
    ]);
    expect(store.get('Mercury (company)')?.frontmatter.RelatedTo).toEqual([
      relation('Ada Lovelace'),
    ]);
    expect(store.get('klex')?.frontmatter.Tags).toEqual([
      'project/stagewise-io',
    ]);
    expect(store.get('mercury (element)')?.frontmatter.Tags).toEqual([
      'element',
    ]);
    // Restart (writer store, no migration rights) is a byte- and mtime-level no-op.
    const file = join(root, 'Ada Lovelace.md');
    const before = await readFile(file, 'utf8');
    const beforeStat = await stat(file);
    expect(before).toContain('FormatVersion: 7');
    const restarted = await restart(root);
    expect(restarted.conversion()).toBeNull();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
  });
  it('dry run plans without writing; the writer store refuses unconverted notes', async () => {
    const { root } = await fixture();
    const file = await seed(root, 'person/Ada.md', v6Note());
    await expect(restart(root)).rejects.toThrow('not migrated');
    const dry = await migrate(root, { dryRun: true });
    expect(dry.conversion()).toMatchObject({ moved: 1, dryRun: true });
    expect(dry.get('Ada')?.frontmatter.Tags).toEqual(['person']);
    await expect(dry.create(fields(), sections())).rejects.toThrow('read-only');
    expect(await readFile(file, 'utf8')).toBe(v6Note());
    expect(await readdir(root)).toEqual(['person']);
    await migrate(root);
    expect(await readdir(root)).toEqual(['Ada.md']);
  });
  it.each([
    [[] as string[]],
    [
      [
        '[[project/Klex|uses protocol (80)]]',
        '[[project/Klex|another label (20)]]',
        '[[learning/deploy/SKILL.md|uses (50)]]',
      ],
    ],
  ])(
    'converts released v0.38.0 format 5 straight to format 7 fallback lists: %j',
    async (links) => {
      const { root } = await fixture();
      await seed(root, 'person/Alex Smith.md', v5Note(links));
      await seed(root, 'project/Klex.md', v5Note());
      const store = await migrate(root);
      expect(store.get('Alex Smith')?.frontmatter.RelatedTo).toEqual(
        links.length ? [relation('Klex'), skill()] : [],
      );
      expect(store.get('Klex')?.frontmatter.RelatedTo).toEqual(
        links.length ? [relation('Alex Smith')] : [],
      );
      const file = join(root, 'Alex Smith.md');
      const converted = await readFile(file, 'utf8');
      expect(converted).toContain('FormatVersion: 7\nTags:\n  - person\n');
      expect(converted).not.toMatch(/\||^RelatedTo:|\((80|50|20)\)/m);
      expect(converted).toContain('- Engineer [old](history:abc)');
      expect((await readdir(root)).sort()).toEqual([
        'Alex Smith.md',
        'Klex.md',
      ]);
      const before = await stat(file);
      await restart(root);
      expect(await readFile(file, 'utf8')).toBe(converted);
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    },
  );
  it.each([3, 4])(
    'converts released format %s object relations to exact format 7 output',
    async (version) => {
      const { root } = await fixture();
      // Frozen released contracts: v3 (v0.37.1-nightly20261117c001) and v4
      // (v0.37.1-nightly20261123c001). Independent of the current serializer.
      const head =
        version === 3
          ? 'FormatVersion: 3\nTitle: Alex Smith\n'
          : 'FormatVersion: 4\n';
      const targetId = version === 3 ? 'BrightOakField' : 'project/Klex';
      const note = `---\n${head}CreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities:\n  - server: slack\n    match:\n      user: U071HL78SDN\nLoadOn: []\nRelatedTo:\n  - target:\n      kind: entity\n      id: ${targetId}\n    strength: 80\n    relationship: works on\n  - target:\n      kind: skill\n      id: learning/deploy\n    strength: 50\n    relationship: "uses [[often]] | daily"\nTrustScore: 2\nAuthorityScore: 5\n---\n\n## General\n\n- Engineer [2026-11-17 · slack](history:abc)\n  - was: Intern [2026-11-01 · slack](history:def)\n`;
      const source = await seed(
        root,
        version === 3 ? 'person/CalmRiverStone.md' : 'person/Alex Smith.md',
        note,
      );
      await seed(
        root,
        version === 3 ? 'project/BrightOakField.md' : 'project/Klex.md',
        version === 3
          ? legacyNote(3, 'Klex')
          : legacyNote(3, 'Klex').replace(
              'FormatVersion: 3\nTitle: Klex\n',
              'FormatVersion: 4\n',
            ),
      );
      const store = await migrate(root);
      await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
      const target = join(root, 'Alex Smith.md');
      const converted = await readFile(target, 'utf8');
      // Literal format 7 output: retain targets, discard labels and strength.
      expect(converted).toBe(
        '---\nFormatVersion: 7\nTags:\n  - person\nCreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities:\n  - server: slack\n    match:\n      user: U071HL78SDN\nLoadOn: []\nTrustScore: 2\nAuthorityScore: 5\nrelatedTo:\n  - "[[Klex]]"\n  - "[[learning/deploy/SKILL.md]]"\n---\n\n## General\n\n- Engineer [2026-11-17 · slack](history:abc)\n  - was: Intern [2026-11-01 · slack](history:def)\n',
      );
      expect(store.get('Klex')?.frontmatter.Tags).toEqual(['project']);
      expect(await readFile(join(root, 'Klex.md'), 'utf8')).toContain(
        'FormatVersion: 7',
      );
      const beforeStat = await stat(target);
      await restart(root);
      expect(await readFile(target, 'utf8')).toBe(converted);
      expect((await stat(target)).mtimeMs).toBe(beforeStat.mtimeMs);
    },
  );
  it.each([1, 2, 3])(
    'converts released format %s, removes title and IDs, preserves evidence and reruns without writes',
    async (version) => {
      const { root } = await fixture();
      const stem = version === 3 ? 'DamnSlaveGod' : legacyId;
      const source = await seed(
        root,
        version === 1 ? `${stem}.md` : `person/${stem}.md`,
        legacyNote(version),
      );
      const store = await migrate(root);
      const entity = store.get('Alex Smith');
      if (!entity) throw new Error('Missing converted entity');
      expect(entity.frontmatter.Tags).toEqual(['person']);
      expect(entity.frontmatter.CreatedAt).toBe('2026-11-12T00:00:00.000Z');
      expect(entity.sections.General?.[0]?.sources).toEqual([
        { label: 'old', id: 'abc' },
      ]);
      await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
      const target = join(root, 'Alex Smith.md');
      const before = await readFile(target, 'utf8');
      const beforeStat = await stat(target);
      expect(before).not.toMatch(/^(Title|Id|EntityType|MergedFrom):/m);
      await restart(root);
      expect(await readFile(target, 'utf8')).toBe(before);
      expect((await stat(target)).mtimeMs).toBe(beforeStat.mtimeMs);
    },
  );
  it.each([1, 2, 3])(
    'converts format %s namespaced titles to leaf titles with the namespace in the tag',
    async (version) => {
      const { store, root } = await fixture();
      const reserved = await store.create(
        { ...fields(), title: 'repo' },
        sections(),
      );
      const source =
        version === 1
          ? `${legacyId}.md`
          : `person/${version === 2 ? legacyId : 'TheOfTo'}.md`;
      const stem = version === 3 ? 'TheOfTo' : legacyId;
      await seed(
        root,
        source,
        legacyNote(version, 'org/repo', '', `See [[${stem}]]`),
      );
      await seed(
        root,
        'project/AndWasWith.md',
        legacyNote(3, 'org/repo/deep/child'),
      );
      const migrated = await migrate(root);
      expect(migrated.get(reserved.id)).toEqual(reserved);
      const converted = migrated.get('repo (person)');
      expect(converted?.frontmatter.Tags).toEqual(['person/org']);
      expect(converted?.sections.General?.[0]?.text).toBe(
        'See [[repo (person)]]',
      );
      expect(migrated.get('child')?.frontmatter.Tags).toEqual([
        'project/org/repo/deep',
      ]);
      const target = join(root, 'repo (person).md');
      const before = await stat(target);
      await restart(root);
      expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
      await expect(readFile(join(root, source))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
  it('qualifies case-insensitive legacy clashes across folders only where needed', async () => {
    const { root } = await fixture();
    await seed(root, 'person/AndWasWith.md', legacyNote());
    await seed(root, 'person/TheOfTo.md', legacyNote(3, 'alex smith'));
    await seed(root, 'project/HisIsHad.md', legacyNote());
    await seed(root, 'team/WeAreHere.md', legacyNote(3, 'Billing'));
    const store = await migrate(root);
    expect(
      store
        .list()
        .map(({ id }) => id)
        .sort(),
    ).toEqual([
      'Alex Smith (person)',
      'Alex Smith (project)',
      'Billing',
      'alex smith (person 2)',
    ]);
  });
  it('trims qualified maximum-length titles within limits', async () => {
    const { store, root } = await fixture();
    const title = 'a'.repeat(100);
    await store.create({ ...fields(), title }, sections());
    await seed(root, 'person/TheOfTo.md', legacyNote(3, title));
    const migrated = await migrate(root);
    const converted = migrated.list().find(({ id }) => id !== title);
    expect(converted?.id.length).toBe(100);
    expect(converted?.id.endsWith(' (person)')).toBe(true);
    expect((await restart(root)).list()).toHaveLength(2);
  });
  it('repoints legacy links and aliases, finishes legacy merges and rewrites whole-ID prose once', async () => {
    const { root } = await fixture();
    await seed(
      root,
      'person/TheOfTo.md',
      legacyNote(3, 'Alex Smith', 'MergedFrom:\n  - AndWasWith\n'),
    );
    await seed(root, 'person/AndWasWith.md', legacyNote(3, 'Duplicate'));
    await seed(
      root,
      'team/HisIsHad.md',
      legacyNote(
        3,
        'Billing',
        '',
        'Led by AndWasWith; not xAndWasWith',
      ).replace(
        'RelatedTo: []',
        'RelatedTo:\n  - target: { kind: entity, id: AndWasWith }\n    strength: 50\n    relationship: knows',
      ),
    );
    const store = await migrate(root);
    expect(store.list()).toHaveLength(2);
    expect(store.get('Billing')?.frontmatter.RelatedTo).toEqual([
      relation('Alex Smith'),
    ]);
    expect(store.get('Billing')?.sections.General?.[0]?.text).toBe(
      'Led by Alex Smith; not xAndWasWith',
    );
    expect(store.get('Alex Smith')?.frontmatter.RelatedTo).toEqual([
      relation('Billing'),
    ]);
    expect(await readFile(join(root, 'Alex Smith.md'), 'utf8')).not.toContain(
      'MergedFrom',
    );
    expect((await readdir(root)).sort()).toEqual([
      'Alex Smith.md',
      'Billing.md',
    ]);
  });
  it('replays a pre-format-7 journal with typed nested IDs, then flattens', async () => {
    const { root } = await fixture();
    const content = v6Note();
    const id = 'project/new/org/repo/deep';
    await seed(root, 'person/old/org/repo.md', content);
    await writeFile(
      join(root, '.moves.json'),
      JSON.stringify({
        moves: [
          {
            from: 'person/old/org/repo',
            to: id,
            path: 'person/old/org/repo.md',
          },
        ],
        documents: [{ id, content }],
      }),
    );
    const store = await migrate(root);
    expect(store.get('deep')?.frontmatter.Tags).toEqual([
      'project/new/org/repo',
    ]);
    expect(await readdir(root)).toEqual(['deep.md']);
  });
  it('validates every document before conversion and leaves invalid, newer or misplaced files untouched', async () => {
    for (const [path, content] of [
      ['person/AndWasWith.md', legacyNote(99)],
      ['project/Klex.md', v5Note(['[[project/Klex|works on (101)]]'])],
      ['project/Klex.md', v5Note(['[[project/Klex|works on]]'])],
      ['project/Bad.md', legacyNote(3, 'org/../repo')],
      // Format 6 must sit in a type folder; format 7 must sit in the root.
      ['Rootless.md', v6Note()],
      [
        'people/Ada.md',
        v6Note().replace(
          'FormatVersion: 6\n',
          'FormatVersion: 7\nTags: [people]\n',
        ),
      ],
      ['Bad Folder/Ada.md', v6Note()],
    ] as const) {
      const { root } = await fixture();
      const old = await seed(root, 'person/TheOfTo.md', legacyNote());
      const file = await seed(root, path, content);
      await expect(migrate(root)).rejects.toThrow();
      expect(await readFile(old, 'utf8')).toBe(legacyNote());
      expect(await readFile(file, 'utf8')).toBe(content);
      expect(await readdir(root)).not.toContain('.moves.json');
    }
  });
  it.skipIf(process.getuid?.() === 0)(
    'preserves original bytes on conversion write failure and retries from its journal',
    async () => {
      const { root } = await fixture();
      const original = v5Note(['[[learning/deploy/SKILL.md|uses (50)]]']);
      const file = await seed(root, 'person/Alex Smith.md', original);
      const folder = dirname(file);
      await chmod(folder, 0o500);
      try {
        await expect(migrate(root)).rejects.toThrow('restart');
        expect(await readFile(file, 'utf8')).toBe(original);
        const journal = JSON.parse(
          await readFile(join(root, '.moves.json'), 'utf8'),
        );
        expect(journal.moves).toEqual([
          {
            from: 'person/Alex Smith',
            to: 'Alex Smith',
            path: 'person/Alex Smith.md',
          },
        ]);
        expect(journal.documents[0].content).toContain('FormatVersion: 7');
        expect(journal.documents[0].content).toContain('relatedTo:');
        expect(journal.documents[0].content).not.toContain('|uses');
      } finally {
        await chmod(folder, 0o700);
      }
      // Replaying a finished plan needs no migration rights.
      const recovered = await restart(root);
      expect(recovered.get('Alex Smith')?.frontmatter.RelatedTo).toEqual([
        skill(),
      ]);
      expect(await readdir(root)).toEqual(['Alex Smith.md']);
    },
  );
});
