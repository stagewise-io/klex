import { randomInt } from 'node:crypto';
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

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEntityStore,
  entityFieldsSchema,
  entityIdSchema,
  loadMatcherSchema,
  renderEntity,
} from './entities';
import { type Fact, formatFacts, parseFacts } from './facts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'memory-entities-'));
  directories.push(directory);
  const store = createEntityStore(join(directory, 'entities'));
  await store.start();
  return { store, directory };
}
afterEach(async () => {
  vi.mocked(randomInt).mockReset();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const fields = () =>
  entityFieldsSchema.parse({ title: 'Alex Smith', entityType: 'person' });
const fact = (text: string, id = 'abc'): Fact => ({
  text,
  sources: [{ label: '2026-11-12 · slack', id }],
  history: [],
});
const sections = (input: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(input).map(([name, text]) => [name, [fact(text)]]),
  );

describe('factual entities', () => {
  it('retries final-string collisions across types and restarts', async () => {
    const { store, directory } = await fixture();
    const random = vi.mocked(randomInt as (max: number) => number);
    random.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(2);
    const first = await store.create(fields(), sections({ General: 'First' }));
    expect(first.id).toBe('TheOfTo');
    random
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3)
      .mockReturnValueOnce(4)
      .mockReturnValueOnce(5);
    const second = await store.create(
      { ...fields(), entityType: 'project' },
      sections({ General: 'Second' }),
    );
    expect(second.id).toBe('AndWasWith');
    const restored = createEntityStore(join(directory, 'entities'));
    await restored.start();
    random
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(6)
      .mockReturnValueOnce(7)
      .mockReturnValueOnce(8);
    const third = await restored.create(
      fields(),
      sections({ General: 'Third' }),
    );
    expect(third.id).toBe('HisIsHad');
    random.mockReturnValue(0);
    await restored.create(fields(), sections({ General: 'Repeat' }));
    await expect(
      restored.create(fields(), sections({ General: 'Collision' })),
    ).rejects.toThrow('100 attempts');
    expect(restored.list()).toHaveLength(4);
  });
  it('preserves lowercase IDs and avoids case-only filename collisions', async () => {
    const { store, directory } = await fixture();
    const random = vi.mocked(randomInt as (max: number) => number);
    random.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(2);
    const entity = await store.create(fields(), sections({ General: 'Fact' }));
    const file = join(directory, 'entities', 'person', `${entity.id}.md`);
    const lowercase = entity.id.toLowerCase();
    const content = await readFile(file, 'utf8');
    await rm(file);
    const legacyFile = join(directory, 'entities', 'person', `${lowercase}.md`);
    await writeFile(legacyFile, content);
    const restored = createEntityStore(join(directory, 'entities'));
    await restored.start();
    expect(restored.get(lowercase)?.id).toBe(lowercase);
    random
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3)
      .mockReturnValueOnce(4)
      .mockReturnValueOnce(5);
    const created = await restored.create(
      fields(),
      sections({ General: 'New' }),
    );
    expect(created.id).toBe('AndWasWith');
    expect(await readFile(legacyFile, 'utf8')).toBe(content);
  });
  it('keeps existing UUID notes and mixed references across restart and title/type updates', async () => {
    const { store, directory } = await fixture();
    const id = '11111111-1111-4111-8111-111111111111';
    const folder = join(directory, 'entities', 'person');
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${id}.md`);
    const legacy = `---\nFormatVersion: 2\nId: ${id}\nTitle: Legacy person\nCreatedAt: 2026-11-12T00:00:00.000Z\nLastUpdatedAt: 2026-11-12T00:00:00.000Z\nLastReadAt: null\nLoadOn:\n  - type: contentPattern\n    pattern: Legacy person\n  - type: pushNotificationMetadataPattern\n    conditions:\n      - path: user\n        match: exact\n        value: U1\nRelatedTo: []\nTrustScore: 2\nAuthorityScore: 5\n---\n\n## General\n\nOld fact\n\nSources: [old](history:abc)\n`;
    await writeFile(file, legacy);
    const restored = createEntityStore(join(directory, 'entities'));
    await restored.start();
    expect(await readFile(file, 'utf8')).toBe(legacy);
    // Unscoped legacy matchers are dropped; prose becomes a cited fact.
    expect(restored.get(id)?.frontmatter.LoadOn).toEqual([
      { type: 'contentPattern', pattern: 'Legacy person' },
    ]);
    expect(restored.get(id)?.sections.General).toEqual([
      { text: 'Old fact', sources: [{ label: 'old', id: 'abc' }], history: [] },
    ]);
    const entity = await restored.create(
      {
        ...fields(),
        relatedTo: [
          {
            target: { kind: 'entity', id },
            strength: 50,
            relationship: 'colleague',
          },
        ],
      },
      sections({ General: 'New fact' }),
    );
    expect(entityIdSchema.safeParse(entity.id).success).toBe(true);
    await restored.update(
      id,
      {
        title: 'Renamed',
        entityType: 'project',
        relatedTo: [
          {
            target: { kind: 'entity', id: entity.id },
            strength: 50,
            relationship: 'colleague',
          },
        ],
      },
      {},
    );
    const again = createEntityStore(join(directory, 'entities'));
    await again.start();
    expect(again.get(id)?.id).toBe(id);
    expect(again.get(id)?.frontmatter.RelatedTo[0]?.target.id).toBe(entity.id);
    expect(again.get(entity.id)?.frontmatter.RelatedTo[0]?.target.id).toBe(id);
    expect(store.list()).toHaveLength(0);
    for (const invalid of [
      '../escape',
      'Uppercase',
      'a-b-c',
      '',
      'a'.repeat(1000),
    ])
      expect(entityIdSchema.safeParse(invalid).success).toBe(false);
  });
  it('persists separate identities with identical titles and reloads markdown', async () => {
    const { store, directory } = await fixture();
    const first = await store.create(
      fields(),
      sections({
        General: 'Engineer',
        Details: 'Project owner',
      }),
    );
    const second = await store.create(
      fields(),
      sections({ General: 'Designer' }),
    );
    expect(first.id).not.toBe(second.id);
    expect(first.frontmatter).toMatchObject({
      TrustScore: 2,
      AuthorityScore: 5,
      LastReadAt: null,
      LoadOn: [],
    });
    const file = await readFile(
      join(directory, 'entities', 'person', `${first.id}.md`),
      'utf8',
    );
    expect(file).toContain('## General');
    expect(file).toContain('FormatVersion: 3');
    expect(file).not.toContain('EntityType:');
    expect(file).not.toMatch(/^Id:/m);
    expect(first.entityType).toBe('person');
    const restored = createEntityStore(join(directory, 'entities'));
    await restored.start();
    expect(restored.list()).toHaveLength(2);
    expect(restored.get(first.id)).toEqual(first);
  });
  it('ignores unknown frontmatter, including a stale Id, and drops it on write', async () => {
    const { store, directory } = await fixture();
    const entity = await store.create(fields(), sections({ General: 'Fact' }));
    const file = join(directory, 'entities', 'person', `${entity.id}.md`);
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        'FormatVersion: 3',
        'FormatVersion: 3\nId: SomethingElseEntirely\ntags:\n  - obsidian',
      ),
    );
    const restored = createEntityStore(join(directory, 'entities'));
    await restored.start();
    expect(restored.get(entity.id)).toEqual(entity);
    await restored.update(entity.id, { title: 'Alex Jones' }, {});
    const rewritten = await readFile(file, 'utf8');
    expect(rewritten).not.toMatch(/^(Id|tags):/m);
  });
  it('protects dates and General, preserves sections and serializes concurrent updates', async () => {
    const { store } = await fixture();
    const original = await store.create(
      fields(),
      sections({
        General: 'Engineer',
        Details: 'Original',
      }),
    );
    const id = original.id;
    await Promise.all([
      store.update(id, { title: 'Alex Jones' }, {}),
      store.update(id, {}, sections({ Extra: 'More' })),
    ]);
    expect(store.get(id)?.sections).toEqual(
      sections({ General: 'Engineer', Details: 'Original', Extra: 'More' }),
    );
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
  it('round-trips fact history and renders only current facts for the reader', async () => {
    const { store } = await fixture();
    const general: Fact = {
      ...fact('Lives in Berlin', 'new'),
      history: [
        {
          text: 'Lives in Paris',
          sources: [{ label: '2026-11-12 · slack', id: 'old' }],
        },
      ],
    };
    const markdown = formatFacts([general]);
    expect(markdown).toBe(
      '- Lives in Berlin [2026-11-12 · slack](history:new)\n  - was: Lives in Paris [2026-11-12 · slack](history:old)',
    );
    expect(parseFacts(markdown)).toEqual([general]);
    const identity = { server: 'slack', match: { user: 'U1' } };
    const entity = await store.create(
      {
        ...fields(),
        linkedIdentities: [identity],
        // Equal to the title or identity, so redundant.
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
    await expect(
      store.create(
        { ...fields(), linkedIdentities: [identity] },
        sections({ General: 'Other' }),
      ),
    ).rejects.toThrow('already belongs to entity');
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
            server: 'slack',
            conditions: [
              { path: 'user', match: 'exact', value: 'U123' },
              { path: 'channel', match: 'glob', value: 'C0*' },
              {
                path: 'payload.issue.identifier',
                match: 'regex',
                value: '^KLEX-\\d+$',
              },
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
      sections({ General: 'Fact' }),
    );
    expect(entity.frontmatter.LoadOn).toHaveLength(2);
    expect(() =>
      loadMatcherSchema.parse({ type: 'toolCallPattern' }),
    ).toThrow();
    for (const condition of [
      { path: 'user', match: 'fuzzy', value: 'U123' },
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
  });
  it('preserves matcher and relation collections when a patch omits them', async () => {
    const { store } = await fixture();
    const target = await store.create(
      fields(),
      sections({ General: 'Colleague' }),
    );
    const entity = await store.create(
      {
        ...fields(),
        loadOn: [{ type: 'contentPattern', pattern: 'deployment team' }],
        relatedTo: [
          {
            target: { kind: 'entity', id: target.id },
            strength: 75,
            relationship: 'colleague',
          },
        ],
      },
      sections({ General: 'Engineer' }),
    );
    const updated = await store.update(
      entity.id,
      { title: 'Alex Jones' },
      sections({ Details: 'More' }),
    );
    expect(updated.frontmatter.RelatedTo).toEqual(entity.frontmatter.RelatedTo);
    expect(updated.frontmatter.LoadOn).toEqual([
      { type: 'contentPattern', pattern: 'deployment team' },
    ]);
    const cleared = await store.update(
      entity.id,
      { loadOn: [], relatedTo: [] },
      {},
    );
    expect(cleared.frontmatter.RelatedTo).toEqual([]);
    expect(cleared.frontmatter.LoadOn).toEqual([]);
  });
  it('moves ontology folders while preserving identity, dates, sources and reloadability', async () => {
    const { store, directory } = await fixture();
    const original = await store.create(
      fields(),
      sections({ General: 'Fact' }),
    );
    const id = original.id;
    const moved = await store.update(id, { entityType: 'project' }, {});
    expect(moved.entityType).toBe('project');
    expect(moved.id).toBe(id);
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
    const original = await store.create(
      fields(),
      sections({ General: 'Fact' }),
    );
    const file = join(directory, 'entities', 'person', `${original.id}.md`);
    const id = '11111111-1111-4111-8111-111111111111';
    const current = (await readFile(file, 'utf8')).replace(
      'FormatVersion: 3',
      `FormatVersion: 2\nId: ${id}`,
    );
    await rm(file);
    const expected = {
      ...original,
      id,
      frontmatter: { ...original.frontmatter, FormatVersion: 2, Id: id },
    };
    const legacy = current.replace(
      'FormatVersion: 2',
      'FormatVersion: 1\nEntityType: person',
    );
    const convertedFile = join(directory, 'entities', 'person', `${id}.md`);
    const flat = join(directory, 'entities', `${id}.md`);
    await writeFile(flat, legacy);
    const migrated = createEntityStore(join(directory, 'entities'));
    await migrated.start();
    expect(migrated.get(id)).toEqual(expected);
    expect(await readFile(convertedFile, 'utf8')).toBe(current);
    await expect(readFile(flat)).rejects.toMatchObject({ code: 'ENOENT' });
    const again = createEntityStore(join(directory, 'entities'));
    await again.start();
    expect(await readFile(convertedFile, 'utf8')).toBe(current);
    await writeFile(convertedFile, legacy);
    await createEntityStore(join(directory, 'entities')).start();
    expect(await readFile(convertedFile, 'utf8')).toBe(current);
  });
  it('validates all documents before conversion and rejects duplicates and newer formats unchanged', async () => {
    const { store, directory } = await fixture();
    const entity = await store.create(fields(), sections({ General: 'Fact' }));
    const file = join(directory, 'entities', 'person', `${entity.id}.md`);
    const current = await readFile(file, 'utf8');
    const legacy = current;
    const flat = join(directory, 'entities', `${entity.id}.md`);
    await writeFile(flat, legacy);
    await expect(
      createEntityStore(join(directory, 'entities')).start(),
    ).rejects.toThrow('Invalid entity');
    expect(await readFile(flat, 'utf8')).toBe(legacy);
    expect(await readFile(file, 'utf8')).toBe(current);
    await rm(flat);
    const newer = current.replace('FormatVersion: 3', 'FormatVersion: 4');
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
