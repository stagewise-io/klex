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
  entityFieldsSchema,
  entityIdSchema,
  entityRevision,
  loadMatcherSchema,
  normalizeEntityName,
  RELATION_INVERSES,
  renderEntity,
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
  entityFieldsSchema.parse({ name: 'Alex Smith', entityType: 'person' });
const fact = (text: string, id = 'abc'): Fact => ({
  text,
  sources: [{ label: '2026-11-12 · slack', id }],
  history: [],
});
const sections = (text = 'Engineer') => ({ General: [fact(text)] });
const relation = (id: string) => ({
  target: { kind: 'entity' as const, id },
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
async function seed(root: string, path: string, content: string) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}
async function restart(root: string) {
  const store = createEntityStore(root);
  await store.start();
  return store;
}

describe('named factual entities', () => {
  it('uses the type-qualified filename, with no title or identity frontmatter', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    expect(entity.id).toBe('person/Alex Smith');
    expect(entity.name).toBe('Alex Smith');
    const content = await readFile(join(root, `${entity.id}.md`), 'utf8');
    expect(content).toContain('FormatVersion: 6');
    expect(content).not.toMatch(/^(Title|Id|EntityType|MergedFrom):/m);
    expect((await restart(root)).get(entity.id)).toEqual(entity);
  });
  it('defines involutive inverses for every curated predicate', () => {
    for (const [predicate, inverse] of Object.entries(RELATION_INVERSES)) {
      expect(RELATION_INVERSES[inverse]).toBe(predicate);
    }
  });
  it.each([
    [],
    [
      '[[project/Klex|uses protocol (80)]]',
      '[[project/Klex|another label (20)]]',
      '[[learning/deploy/SKILL.md|uses (50)]]',
    ],
  ])(
    'migrates format 5 labels and strengths directly to deduplicated fallback lists: %j',
    async (...links) => {
      const { root } = await fixture();
      const original = legacyNote()
        .replace('FormatVersion: 3\nTitle: Alex Smith\n', 'FormatVersion: 5\n')
        .replace('RelatedTo: []', `RelatedTo: ${JSON.stringify(links)}`);
      const file = await seed(root, 'person/Alex Smith.md', original);
      const store = await restart(root);
      expect(store.get('person/Alex Smith')?.frontmatter.RelatedTo).toEqual(
        links.length
          ? [
              relation('project/Klex'),
              {
                target: { kind: 'skill', id: 'learning/deploy' },
                relationship: 'relatedTo',
              },
            ]
          : [],
      );
      const converted = await readFile(file, 'utf8');
      expect(converted).not.toMatch(/\||^RelatedTo:/m);
      expect(converted).toContain('FormatVersion: 6');
      await restart(root);
      expect(await readFile(file, 'utf8')).toBe(converted);
    },
  );
  it('preserves different predicates to one target and rejects unknown frontmatter predicates', async () => {
    const { root, store } = await fixture();
    const entity = await store.create(
      {
        ...fields(),
        relatedTo: [
          relation('project/Klex'),
          { ...relation('project/Klex'), relationship: 'uses' },
          relation('project/Klex'),
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
  it('rejects duplicate names ignoring case, including concurrent creation and restart', async () => {
    const { store, root } = await fixture();
    const results = await Promise.allSettled([
      store.create(fields(), sections()),
      store.create({ ...fields(), name: 'alex smith' }, sections()),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    await expect(
      (await restart(root)).create(fields(), sections()),
    ).rejects.toThrow('already exists');
    const project = await store.create(
      { ...fields(), entityType: 'project' },
      sections(),
    );
    expect(project.id).toBe('project/Alex Smith');
    expect(store.get('person/alex smith')?.id).toBe('person/Alex Smith');
  });
  it('normalizes unsafe names while leaving spelling and casing to the writer', async () => {
    const { store } = await fixture();
    expect(normalizeEntityName(' .. acme/web: API?  .. ')).toBe('acme/web API');
    expect(normalizeEntityName('CON')).toBe('_CON');
    expect(normalizeEntityName('e\u0301')).toBe('é');
    const entity = await store.create(
      { ...fields(), name: 'acme/web: API?' },
      sections(),
    );
    expect(entity.id).toBe('person/acme/web API');
    for (const id of [
      '../escape',
      'person/../escape',
      'Person/Name',
      'person/.',
      'person//b',
      'person/a/../b',
      'person/a/./b',
      'person/a/',
      'person/a\\b',
      'person/Name.md/other',
      'person/Bad#Name',
    ])
      expect(entityIdSchema.safeParse(id).success).toBe(false);
    await expect(
      store.create({ ...fields(), name: '///' }, sections()),
    ).rejects.toThrow();
  });
  it('creates deeply nested names, preserves slash identity, canonicalizes shared folders and reloads', async () => {
    const { store, root } = await fixture();
    const name = 'GitHub/stagewise-io/products/backend/klex';
    const entity = await store.create(
      { ...fields(), entityType: 'project', name },
      sections(),
    );
    expect(entity.id).toBe(`project/${name}`);
    expect(entity.name).toBe(name);
    await store.recordRead(entity.id);
    const second = await store.create(
      {
        ...fields(),
        entityType: 'project',
        name: 'github/STAGEWISE-IO/products/backend/web',
      },
      sections(),
    );
    expect(second.id).toBe('project/GitHub/stagewise-io/products/backend/web');
    await expect(
      store.create(
        { ...fields(), entityType: 'project', name: name.toLowerCase() },
        sections(),
      ),
    ).rejects.toThrow('already exists');
    const flat = await store.create(
      { ...fields(), entityType: 'project', name: name.replaceAll('/', ' ') },
      sections(),
    );
    expect(flat.id).not.toBe(entity.id);
    const restored = await restart(root);
    expect(restored.list()).toHaveLength(3);
    expect(restored.get(entity.id.toLowerCase())?.name).toBe(name);
    expect(await readFile(join(root, `${entity.id}.md`), 'utf8')).toContain(
      'Engineer',
    );
  });
  it('renames, retypes and merges nested notes while rewriting whole references and preserving descendants', async () => {
    const { store, root } = await fixture();
    const original = await store.create(
      { ...fields(), name: 'org/repo' },
      sections(),
    );
    const child = await store.create(
      { ...fields(), name: 'org/repo/child' },
      sections(),
    );
    const peer = await store.create(
      {
        ...fields(),
        name: 'other/team/Peer',
        relatedTo: [relation(original.id)],
      },
      sections(`See [[${original.id}]], not ${original.id}/child`),
    );
    const moved = await store.update(
      original.id,
      { name: 'new/org/repo', entityType: 'project' },
      {},
    );
    expect(store.get(peer.id)?.sections.General?.[0]?.text).toBe(
      `See [[${moved.id}]], not ${original.id}/child`,
    );
    expect(store.get(peer.id)?.frontmatter.RelatedTo).toEqual([
      relation(moved.id),
    ]);
    expect((await restart(root)).get(child.id)).toEqual(child);
    const updatedPeer = store.get(peer.id);
    if (!updatedPeer) throw new Error('Missing peer after rename');
    await store.merge(
      moved.id,
      peer.id,
      entityRevision(moved),
      entityRevision(updatedPeer),
    );
    const restored = await restart(root);
    expect(restored.get(peer.id)).toBeNull();
    expect(restored.get(moved.id)?.sections.General).toHaveLength(2);
    await expect(stat(join(root, 'person/other'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it.each([1, 2, 3])(
    'converts format %s slash titles with reserved names, suffixes, references and idempotent restart',
    async (version) => {
      const { store, root } = await fixture();
      const reserved = await store.create(
        { ...fields(), name: 'org/repo' },
        sections(),
      );
      await store.create({ ...fields(), name: 'org/repo 2' }, sections());
      const source =
        version === 1
          ? `${legacyId}.md`
          : `person/${version === 2 ? legacyId : 'TheOfTo'}.md`;
      const stem = version === 3 ? 'TheOfTo' : legacyId;
      await seed(
        root,
        source,
        legacyNote(version, 'org/repo', '', `See [[${stem}]]`).replace(
          'RelatedTo: []',
          `RelatedTo:\n  - target: { kind: entity, id: ${stem} }\n    strength: 50\n    relationship: knows`,
        ),
      );
      await seed(
        root,
        'project/AndWasWith.md',
        legacyNote(3, 'org/repo/deep/child'),
      );
      const migrated = await restart(root);
      expect(migrated.get(reserved.id)).toEqual(reserved);
      const converted = migrated.get('person/org/repo 3');
      expect(converted?.name).toBe('org/repo 3');
      expect(converted?.sections.General?.[0]?.text).toBe(
        'See [[person/org/repo 3]]',
      );
      expect(migrated.get('project/org/repo/deep/child')).not.toBeNull();
      const target = join(root, 'person/org/repo 3.md');
      const before = await stat(target);
      await restart(root);
      expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
      await expect(readFile(join(root, source))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
  it('reserves empty folder casing and suffixes maximum-length nested titles within all limits', async () => {
    const { root } = await fixture();
    await mkdir(join(root, 'person/Existing/Empty'), { recursive: true });
    let store = await restart(root);
    const entity = await store.create(
      { ...fields(), name: 'existing/empty/Note' },
      sections(),
    );
    expect(entity.id).toBe('person/Existing/Empty/Note');
    const name = `${'a'.repeat(99)}/${'b'.repeat(100)}`;
    await store.create({ ...fields(), name }, sections());
    await seed(root, 'person/TheOfTo.md', legacyNote(3, name));
    store = await restart(root);
    const converted = store.list().find((item) => item.name.endsWith(' 2'));
    expect(converted?.name.length).toBe(200);
    expect(converted && entityIdSchema.safeParse(converted.id).success).toBe(
      true,
    );
    expect((await restart(root)).list()).toHaveLength(3);
  });
  it('rejects unsafe path segments and excessive path lengths without writing', async () => {
    const { store, root } = await fixture();
    for (const name of [
      '/absolute',
      'org//repo',
      'org/../repo',
      'org/./repo',
      'org/',
      'org/ /repo',
      'org/???/repo',
      'org/readme.md/repo',
      'org/repo.md',
      `${'a'.repeat(100)}/${'b'.repeat(100)}`,
    ]) {
      await expect(
        Promise.resolve().then(() =>
          store.create({ ...fields(), name }, sections()),
        ),
      ).rejects.toThrow();
    }
    expect(await readdir(root)).toEqual([]);
    await seed(root, 'person/TheOfTo.md', legacyNote(3, 'org/../repo'));
    await expect(restart(root)).rejects.toThrow();
    expect(await readFile(join(root, 'person/TheOfTo.md'), 'utf8')).toContain(
      'Title: org/../repo',
    );
    expect(await readdir(root)).not.toContain('.moves.json');
  });
  it('rejects intermediate symlinks during load, writes and journal replay before deleting sources', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const outside = join(root, '..', 'outside');
    await mkdir(outside);
    await mkdir(join(root, 'project'));
    await symlink(outside, join(root, 'project/org'));
    await expect(
      store.create(
        { ...fields(), entityType: 'project', name: 'org/deep/repo' },
        sections(),
      ),
    ).rejects.toThrow('plain directory');
    await expect(restart(root)).rejects.toThrow('plain directory');
    const content = await readFile(join(root, `${entity.id}.md`), 'utf8');
    await writeFile(
      join(root, '.moves.json'),
      JSON.stringify({
        moves: [
          {
            from: entity.id,
            to: 'project/org/deep/repo',
            path: `${entity.id}.md`,
          },
        ],
        documents: [{ id: 'project/org/deep/repo', content }],
      }),
    );
    await expect(restart(root)).rejects.toThrow('plain directory');
    expect(await readFile(join(root, `${entity.id}.md`), 'utf8')).toBe(content);
    expect(await readdir(outside)).toEqual([]);
  });
  it('replays nested renames even when former parents have already been removed', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(
      { ...fields(), name: 'old/org/repo' },
      sections(),
    );
    const content = await readFile(join(root, `${entity.id}.md`), 'utf8');
    const id = 'project/new/org/repo/deep';
    const journal = JSON.stringify({
      moves: [{ from: entity.id, to: id, path: `${entity.id}.md` }],
      documents: [{ id, content }],
    });
    await writeFile(join(root, '.moves.json'), journal);
    await rm(join(root, 'person'), { recursive: true });
    const recovered = await restart(root);
    expect(recovered.get(id)?.name).toBe('new/org/repo/deep');
    await writeFile(join(root, '.moves.json'), journal);
    expect((await restart(root)).get(id)).toEqual(recovered.get(id));
  });
  it('renames and retypes files and every relation and whole qualified mention together', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const peer = await store.create(
      {
        name: 'Sam Lee',
        entityType: 'person',
        relatedTo: [relation(entity.id)],
      },
      {
        General: [
          {
            ...fact(
              `Works with [[${entity.id}]], not x${entity.id} or ${entity.id}son`,
            ),
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
    const moved = await store.update(
      entity.id,
      { name: 'Alex Jones', entityType: 'project' },
      {},
    );
    expect(moved.id).toBe('project/Alex Jones');
    expect(store.get(entity.id)).toBeNull();
    expect(moved.frontmatter.CreatedAt).toBe(entity.frontmatter.CreatedAt);
    expect(moved.sections).toEqual(entity.sections);
    await expect(readFile(join(root, `${entity.id}.md`))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    const restored = await restart(root);
    expect(restored.get(moved.id)).toEqual(moved);
    const changed = restored.get(peer.id);
    if (!changed) throw new Error('Missing peer');
    expect(changed.frontmatter.RelatedTo).toEqual([relation(moved.id)]);
    expect(changed.sections.General?.[0]?.text).toBe(
      `Works with [[${moved.id}]], not x${entity.id} or ${entity.id}son`,
    );
    expect(changed.sections.General?.[0]?.history[0]).toEqual({
      text: `Met ${moved.id}.`,
      sources: [{ label: moved.id, id: 'evidence-id' }],
    });
    expect(await readdir(root)).not.toContain('.moves.json');
  });
  it('supports case-only renames without duplicate directory entries', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const updated = await store.update(entity.id, { name: 'ALEX SMITH' }, {});
    expect(await readdir(join(root, 'person'))).toEqual(['ALEX SMITH.md']);
    expect((await restart(root)).get(updated.id)).toEqual(updated);
  });
  it('rejects rename collisions without modifying either entity', async () => {
    const { store } = await fixture();
    const first = await store.create(fields(), sections());
    const second = await store.create(
      { ...fields(), name: 'Other Person' },
      sections(),
    );
    await expect(
      store.update(second.id, { name: 'alex smith' }, {}),
    ).rejects.toThrow('already exists');
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
            type: 'pushNotificationMetadataPattern',
            server: 'slack',
            conditions: [{ path: 'user', match: 'exact', value: 'U1' }],
          },
        ],
      },
      { General: [general], Details: [fact('Details')] },
    );
    expect(entity.frontmatter.LoadOn).toEqual([]);
    expect(renderEntity(entity)).toBe(
      '# Alex Smith\n\nIDs: slack user=U1\n\n## General\n- Lives in Berlin',
    );
    expect(renderEntity(entity, ['Details'])).toContain('- Details');
    expect((await restart(root)).get(entity.id)?.sections.General).toEqual([
      general,
    ]);
    await expect(
      store.create(
        { ...fields(), name: 'Other Person', linkedIdentities: [identity] },
        sections(),
      ),
    ).rejects.toThrow('already belongs');
  });
  it('validates extensible ontology and matcher conditions', () => {
    for (const condition of [
      { path: 'user', match: 'fuzzy', value: 'U1' },
      { path: 'user', match: 'regex', value: '(' },
      { path: 'user', match: 'glob', value: 5 },
    ])
      expect(() =>
        loadMatcherSchema.parse({
          type: 'pushNotificationMetadataPattern',
          server: 'slack',
          conditions: [condition],
        }),
      ).toThrow();
    expect(
      entityFieldsSchema.parse({
        name: 'Example',
        entityType: 'custom-domain-type',
        loadOn: [
          { type: 'toolCallPattern', mcpServer: 'slack', arguments: [] },
        ],
      }).entityType,
    ).toBe('custom-domain-type');
  });
  it('merges facts, identities and links without persistent aliases; names can be reused', async () => {
    const { store, root } = await fixture();
    const keep = await store.create(fields(), sections());
    const drop = await store.create(
      {
        ...fields(),
        name: 'Alex S',
        linkedIdentities: [{ server: 'slack', match: { user: 'U1' } }],
      },
      { General: [fact('Engineer', 'other'), fact('Owns billing')] },
    );
    const peer = await store.create(
      {
        name: 'Sam Lee',
        entityType: 'person',
        relatedTo: [relation(keep.id), relation(drop.id)],
      },
      sections(`Met ${drop.id}`),
    );
    await expect(
      store.merge(keep.id, drop.id, 'stale', entityRevision(drop)),
    ).rejects.toThrow('read both');
    const merged = await store.merge(
      keep.id,
      drop.id,
      entityRevision(keep),
      entityRevision(drop),
    );
    expect(merged.sections.General?.map(({ text }) => text)).toEqual([
      'Engineer',
      'Owns billing',
    ]);
    expect(merged.sections.General?.[0]?.sources.map(({ id }) => id)).toEqual([
      'abc',
      'other',
    ]);
    expect(merged.frontmatter.LinkedIdentities).toHaveLength(1);
    expect(merged.frontmatter).not.toHaveProperty('MergedFrom');
    const restored = await restart(root);
    expect(restored.get(drop.id)).toBeNull();
    expect(restored.get(peer.id)?.frontmatter.RelatedTo).toEqual([
      relation(keep.id),
    ]);
    expect(restored.get(peer.id)?.sections.General?.[0]?.text).toBe(
      `Met ${keep.id}`,
    );
    await expect(restored.update(drop.id, {}, {})).rejects.toThrow(
      'Unknown entity',
    );
    expect(
      (await restored.create({ ...fields(), name: drop.name }, sections())).id,
    ).toBe(drop.id);
  });
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
      const store = await restart(root);
      const entity = store.get('person/Alex Smith');
      if (!entity) throw new Error('Missing converted entity');
      expect(entity.frontmatter.CreatedAt).toBe('2026-11-12T00:00:00.000Z');
      expect(entity.sections.General?.[0]?.sources).toEqual([
        { label: 'old', id: 'abc' },
      ]);
      await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
      const target = join(root, 'person/Alex Smith.md');
      const before = await readFile(target, 'utf8');
      const beforeStat = await stat(target);
      expect(before).not.toMatch(/^(Title|Id|MergedFrom):/m);
      await restart(root);
      expect(await readFile(target, 'utf8')).toBe(before);
      expect((await stat(target)).mtimeMs).toBe(beforeStat.mtimeMs);
    },
  );
  it('stores relations as Obsidian links and rejects malformed links and labels', async () => {
    const { store, root } = await fixture();
    const target = await store.create(
      { ...fields(), name: 'Lead Person' },
      sections('Lead'),
    );
    const relations = [
      { ...relation(target.id), relationship: 'reportsTo' as const },
      {
        target: { kind: 'skill' as const, id: 'learning/deploy' },
        relationship: 'uses' as const,
      },
    ];
    const entity = await store.create(
      { ...fields(), relatedTo: relations },
      sections(),
    );
    const file = join(root, `${entity.id}.md`);
    const content = await readFile(file, 'utf8');
    expect(content).toContain(
      'reportsTo:\n  - "[[person/Lead Person]]"\nuses:\n  - "[[learning/deploy/SKILL.md]]"\n',
    );
    expect((await restart(root)).get(entity.id)).toEqual(entity);
    await writeFile(
      file,
      content.replace(
        '[[person/Lead Person]]',
        '[[person/Lead Person|reports to]]',
      ),
    );
    await expect(restart(root)).rejects.toThrow('Invalid entity');
    expect(() =>
      entityFieldsSchema.parse({
        ...fields(),
        relatedTo: [{ ...relations[0], relationship: 'a|b' }],
      }),
    ).toThrow();
  });
  it.each([3, 4])(
    'converts released format %s object relations to exact v6 fallback lists',
    async (version) => {
      const { root } = await fixture();
      // Frozen released contracts: v3 (v0.37.1-nightly20261117c001) and v4
      // (v0.37.1-nightly20261123c001). Independent of the current serializer.
      const head =
        version === 3
          ? 'FormatVersion: 3\nTitle: Alex Smith\n'
          : 'FormatVersion: 4\n';
      const targetId = version === 3 ? 'BrightOakField' : 'project/Klex';
      const note = (relatedTo: string, first = head) =>
        `---\n${first}CreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities:\n  - server: slack\n    match:\n      user: U071HL78SDN\nLoadOn: []\nRelatedTo:\n${relatedTo}TrustScore: 2\nAuthorityScore: 5\n---\n\n## General\n\n- Engineer [2026-11-17 · slack](history:abc)\n  - was: Intern [2026-11-01 · slack](history:def)\n`;
      const source = await seed(
        root,
        version === 3 ? 'person/CalmRiverStone.md' : 'person/Alex Smith.md',
        note(
          `  - target:\n      kind: entity\n      id: ${targetId}\n    strength: 80\n    relationship: works on\n  - target:\n      kind: skill\n      id: learning/deploy\n    strength: 50\n    relationship: "uses [[often]] | daily"\n`,
        ),
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
      const store = await restart(root);
      const target = join(root, 'person/Alex Smith.md');
      if (version === 3)
        await expect(readFile(source)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      const converted = await readFile(target, 'utf8');
      // Literal v6 output: retain targets, discard labels and strength.
      expect(converted).toBe(
        '---\nFormatVersion: 6\nCreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities:\n  - server: slack\n    match:\n      user: U071HL78SDN\nLoadOn: []\nTrustScore: 2\nAuthorityScore: 5\nrelatedTo:\n  - "[[project/Klex]]"\n  - "[[learning/deploy/SKILL.md]]"\n---\n\n## General\n\n- Engineer [2026-11-17 · slack](history:abc)\n  - was: Intern [2026-11-01 · slack](history:def)\n',
      );
      expect(store.get('person/Alex Smith')?.frontmatter.RelatedTo).toEqual([
        { ...relation('project/Klex'), relationship: 'relatedTo' },
        {
          target: { kind: 'skill', id: 'learning/deploy' },
          relationship: 'relatedTo',
        },
      ]);
      expect(await readFile(join(root, 'project/Klex.md'), 'utf8')).toContain(
        'FormatVersion: 6',
      );
      const beforeStat = await stat(target);
      await restart(root);
      expect(await readFile(target, 'utf8')).toBe(converted);
      expect((await stat(target)).mtimeMs).toBe(beforeStat.mtimeMs);
    },
  );
  it.each([
    [],
    [
      '[[project/Klex|works on (80)]]',
      '[[learning/deploy/SKILL.md|uses (50)]]',
    ],
  ])(
    'converts released v5 links to predicate lists and does not rewrite on restart: %j',
    async (...links) => {
      const { root } = await fixture();
      const relatedTo = links.length
        ? `RelatedTo:\n${links.map((link) => `  - "${link}"\n`).join('')}`
        : 'RelatedTo: []\n';
      const original = `---\nFormatVersion: 5\nCreatedAt: 2026-11-17T10:00:00.000Z\nLastUpdatedAt: 2026-11-17T11:00:00.000Z\nLastReadAt: null\nLinkedIdentities: []\nLoadOn: []\n${relatedTo}TrustScore: 2\nAuthorityScore: 5\n---\n\n## General\n\n- Engineer [old](history:abc)\n`;
      const file = await seed(root, 'person/Alex Smith.md', original);
      const store = await restart(root);
      expect(store.get('person/Alex Smith')?.frontmatter.RelatedTo).toEqual(
        links.length
          ? [
              {
                target: { kind: 'entity', id: 'project/Klex' },
                relationship: 'relatedTo',
              },
              {
                target: { kind: 'skill', id: 'learning/deploy' },
                relationship: 'relatedTo',
              },
            ]
          : [],
      );
      const converted = await readFile(file, 'utf8');
      expect(converted).toContain('FormatVersion: 6');
      expect(converted).not.toMatch(/\((80|50)\)/);
      expect(converted).toContain('- Engineer [old](history:abc)');
      const before = await stat(file);
      await restart(root);
      expect(await readFile(file, 'utf8')).toBe(converted);
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    },
  );
  it.each(['[[project/Klex|works on (101)]]', '[[project/Klex|works on]]'])(
    'leaves invalid v5 links and valid old documents untouched: %s',
    async (link) => {
      const { root } = await fixture();
      const old = await seed(root, 'person/CalmRiverStone.md', legacyNote());
      const invalid = legacyNote()
        .replace('FormatVersion: 3\nTitle: Alex Smith\n', 'FormatVersion: 5\n')
        .replace('RelatedTo: []', `RelatedTo:\n  - "${link}"`);
      const file = await seed(root, 'project/Klex.md', invalid);
      await expect(restart(root)).rejects.toThrow('Invalid entity');
      expect(await readFile(old, 'utf8')).toBe(legacyNote());
      expect(await readFile(file, 'utf8')).toBe(invalid);
    },
  );
  it.skipIf(process.getuid?.() === 0)(
    'preserves original v5 bytes on conversion write failure and retries from its journal',
    async () => {
      const { root } = await fixture();
      const original = legacyNote()
        .replace('FormatVersion: 3\nTitle: Alex Smith\n', 'FormatVersion: 5\n')
        .replace(
          'RelatedTo: []',
          'RelatedTo: ["[[project/Klex|works on (80)]]"]',
        );
      const file = await seed(root, 'person/Alex Smith.md', original);
      const folder = dirname(file);
      await chmod(folder, 0o500);
      try {
        await expect(restart(root)).rejects.toThrow('restart');
        expect(await readFile(file, 'utf8')).toBe(original);
        const journal = JSON.parse(
          await readFile(join(root, '.moves.json'), 'utf8'),
        );
        expect(journal.moves).toEqual([]);
        expect(journal.documents[0].content).toContain('FormatVersion: 6');
        expect(journal.documents[0].content).toContain('relatedTo:');
        expect(journal.documents[0].content).not.toContain('|works on');
      } finally {
        await chmod(folder, 0o700);
      }
      const recovered = await restart(root);
      expect(recovered.get('person/Alex Smith')?.frontmatter.RelatedTo).toEqual(
        [relation('project/Klex')],
      );
      expect(await readdir(root)).not.toContain('.moves.json');
      const converted = await readFile(file, 'utf8');
      await restart(root);
      expect(await readFile(file, 'utf8')).toBe(converted);
    },
  );
  it('rejects relation strength and arbitrary predicates in current tool fields', async () => {
    expect(() =>
      entityFieldsSchema.parse({
        ...fields(),
        relatedTo: [{ ...relation('project/Klex'), strength: 80 }],
      }),
    ).toThrow();
    for (const relationship of [
      'uses protocol (80)',
      'works on',
      'belongsTo',
      'Uses',
    ]) {
      expect(() =>
        entityFieldsSchema.parse({
          ...fields(),
          relatedTo: [{ ...relation('project/Klex'), relationship }],
        }),
      ).toThrow();
    }
  });
  it('suffixes duplicate legacy titles within their type, not across types', async () => {
    const { root } = await fixture();
    await seed(root, 'person/AndWasWith.md', legacyNote());
    await seed(root, 'person/TheOfTo.md', legacyNote(3, 'alex smith'));
    await seed(root, 'project/HisIsHad.md', legacyNote());
    expect(
      (await restart(root))
        .list()
        .map(({ id }) => id)
        .sort(),
    ).toEqual([
      'person/Alex Smith',
      'person/alex smith 2',
      'project/Alex Smith',
    ]);
  });
  it('repoints legacy links and aliases, finishes legacy merges and rewrites whole-ID history', async () => {
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
    const store = await restart(root);
    expect(store.list()).toHaveLength(2);
    expect(store.get('team/Billing')?.frontmatter.RelatedTo).toEqual([
      relation('person/Alex Smith'),
    ]);
    expect(store.get('team/Billing')?.sections.General?.[0]?.text).toBe(
      'Led by person/Alex Smith; not xAndWasWith',
    );
    expect(
      await readFile(join(root, 'person/Alex Smith.md'), 'utf8'),
    ).not.toContain('MergedFrom');
  });
  it('validates every document before conversion and leaves invalid/newer files untouched', async () => {
    const { root } = await fixture();
    const old = await seed(root, 'person/TheOfTo.md', legacyNote());
    const newer = await seed(root, 'person/AndWasWith.md', legacyNote(99));
    await expect(restart(root)).rejects.toThrow('Invalid entity');
    expect(await readFile(old, 'utf8')).toBe(legacyNote());
    expect(await readFile(newer, 'utf8')).toBe(legacyNote(99));
    expect(await readdir(root)).not.toContain('.moves.json');
  });
  it('rejects invalid legacy identities and symlinked roots and folders without changes', async () => {
    const { root } = await fixture();
    const old = await seed(root, 'person/TheOfTo.md', legacyNote());
    const linked = `${root}-linked`;
    directories.push(linked);
    await symlink(root, linked);
    await expect(restart(linked)).rejects.toThrow('plain directory');
    await symlink(join(root, 'person'), join(root, 'project'));
    await expect(restart(root)).rejects.toThrow('plain directory');
    expect(await readFile(old, 'utf8')).toBe(legacyNote());
  });
  it('replays final snapshots when interrupted after source removal or partial writes', async () => {
    const { store, root } = await fixture();
    const entity = await store.create(fields(), sections());
    const oldContent = await readFile(join(root, `${entity.id}.md`), 'utf8');
    const id = 'project/New Name';
    const journal = {
      moves: [{ from: entity.id, to: id, path: `${entity.id}.md` }],
      documents: [{ id, content: oldContent }],
    };
    await writeFile(join(root, '.moves.json'), JSON.stringify(journal));
    await rm(join(root, `${entity.id}.md`));
    const recovered = await restart(root);
    expect(recovered.get(id)?.name).toBe('New Name');
    expect(recovered.get(entity.id)).toBeNull();
    // Replaying the same journal after a complete write is also safe.
    await writeFile(join(root, '.moves.json'), JSON.stringify(journal));
    expect((await restart(root)).get(id)).toEqual(recovered.get(id));
  });
  it.skipIf(process.getuid?.() === 0)(
    'journals a failed rename and completes it on restart',
    async () => {
      const { store, root } = await fixture();
      const entity = await store.create(fields(), sections());
      const folder = join(root, 'project');
      await mkdir(folder);
      await chmod(folder, 0o500);
      try {
        await expect(
          store.update(entity.id, { entityType: 'project' }, {}),
        ).rejects.toThrow('restart');
        await expect(
          store.create({ ...fields(), name: 'Other Person' }, sections()),
        ).rejects.toThrow('restart');
      } finally {
        await chmod(folder, 0o700);
      }
      expect((await restart(root)).get('project/Alex Smith')?.sections).toEqual(
        entity.sections,
      );
      expect(await readdir(root)).not.toContain('.moves.json');
    },
  );
});
