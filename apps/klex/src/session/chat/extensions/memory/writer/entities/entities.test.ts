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
const relation = (id: string, strength = 50) => ({
  target: { kind: 'entity' as const, id },
  strength,
  relationship: 'knows',
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
    expect(content).toContain('FormatVersion: 4');
    expect(content).not.toMatch(/^(Title|Id|EntityType|MergedFrom):/m);
    expect((await restart(root)).get(entity.id)).toEqual(entity);
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
    expect(normalizeEntityName(' .. acme/web: API?  .. ')).toBe('acme web API');
    expect(normalizeEntityName('CON')).toBe('_CON');
    expect(normalizeEntityName('e\u0301')).toBe('é');
    const entity = await store.create(
      { ...fields(), name: 'acme/web: API?' },
      sections(),
    );
    expect(entity.id).toBe('person/acme web API');
    for (const id of [
      '../escape',
      'person/../escape',
      'Person/Name',
      'person/.',
      'person/a/b',
      'person/Name.md/other',
      'person/Bad#Name',
    ])
      expect(entityIdSchema.safeParse(id).success).toBe(false);
    await expect(
      store.create({ ...fields(), name: '///' }, sections()),
    ).rejects.toThrow();
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
        relatedTo: [relation(keep.id, 80), relation(drop.id, 20)],
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
      relation(keep.id, 80),
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
