import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { createSkillRegistry, type SkillRegistry } from '@/skills';

import {
  deleteLegacySkill,
  deleteLegacySkillRoute,
  deleteSkill,
  deleteSkillRoute,
  getLegacySkill,
  getLegacySkillRoute,
  getSkill,
  getSkillRoute,
  listSkills,
  listSkillsRoute,
  replaceTemplateSkills,
  replaceTemplateSkillsRoute,
  updateLegacySkill,
  updateLegacySkillRoute,
  updateSkill,
  updateSkillRoute,
} from './skills';
import { setupTestApp } from './test-utils';

const directories: string[] = [];
const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as ModuleLogger;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function seededRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'klex-skills-admin-'));
  directories.push(directory);
  const registry = createSkillRegistry({ dataDirectory: directory, logger });
  await registry.start();
  registry.claimNamespace('io.stagewise/learning', 'learning');
  registry.claimNamespace('example.notes', 'notes');
  const learning = registry.forNamespace('learning');
  await learning.put(
    'verify-node-version',
    { description: 'Use before running tests on a VM.', body: 'Run nvm use.' },
    { metadata: { sourceEpisodes: ['episode-1'] } },
  );
  await learning.put('shared', { description: 'Learned.', body: 'L.' });
  await registry
    .forNamespace('notes')
    .put(
      'shared',
      { description: 'Templated.', body: 'T.' },
      { metadata: { sourceEpisodes: 'not-a-list', template: 'x' } },
    );
  return registry;
}

function createApp(skillRegistry: SkillRegistry) {
  return setupTestApp((app) => {
    const deps = { skillRegistry };
    app.openapi(listSkillsRoute, listSkills(deps));
    app.openapi(getSkillRoute, getSkill(deps));
    app.openapi(updateSkillRoute, updateSkill(deps));
    app.openapi(deleteSkillRoute, deleteSkill(deps));
    app.openapi(replaceTemplateSkillsRoute, replaceTemplateSkills(deps));
    app.openapi(getLegacySkillRoute, getLegacySkill(deps));
    app.openapi(updateLegacySkillRoute, updateLegacySkill(deps));
    app.openapi(deleteLegacySkillRoute, deleteLegacySkill(deps));
  });
}

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const template = (name: string, body = `Body of ${name}.`) => ({
  name,
  description: `Use for ${name}.`,
  body,
});

describe('skills routes', () => {
  it('lists skills of every namespace with ids, sources and the clock', async () => {
    const registry = await seededRegistry();
    registry.tick();
    const res = await createApp(registry).request('/v1/skills');

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      currentTurn: number;
      skills: { id: string; origin: string }[];
    };
    expect(json.currentTurn).toBe(1);
    expect(json.skills.map((skill) => [skill.id, skill.origin])).toEqual([
      ['learning/shared', 'learned'],
      ['learning/verify-node-version', 'learned'],
      ['notes/shared', 'notes'],
    ]);
    expect(json.skills[1]).toMatchObject({
      namespace: 'learning',
      name: 'verify-node-version',
      readCount: 0,
      lastReadAt: null,
      createdTurn: 0,
      lastReadTurn: null,
      userEdited: false,
      metadata: { sourceEpisodes: ['episode-1'] },
    });
    expect(json.skills[1]).not.toHaveProperty('body');
  });

  it('returns a qualified skill with body and deprecated fields', async () => {
    const app = createApp(await seededRegistry());
    const learned = await app.request(
      '/v1/skills/learning/verify-node-version',
    );
    expect(learned.status).toBe(200);
    expect(await learned.json()).toMatchObject({
      id: 'learning/verify-node-version',
      body: 'Run nvm use.',
      origin: 'learned',
      sourceEpisodes: ['episode-1'],
      currentTurn: 0,
    });

    const noted = await app.request('/v1/skills/notes/shared');
    expect(await noted.json()).toMatchObject({
      origin: 'notes',
      sourceEpisodes: [],
      metadata: { sourceEpisodes: 'not-a-list', template: 'x' },
    });
  });

  it('edits skills of any namespace and marks them user-edited', async () => {
    const registry = await seededRegistry();
    const res = await createApp(registry).request(
      '/v1/skills/notes/shared',
      patch({ body: '  Edited.  ' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      body: 'Edited.',
      description: 'Templated.',
      userEdited: true,
    });
    expect(registry.get('learning/shared')?.body).toBe('L.');
  });

  it('ignores metadata in edits', async () => {
    const registry = await seededRegistry();
    const res = await createApp(registry).request(
      '/v1/skills/learning/verify-node-version',
      patch({ body: 'Edited.', metadata: { sourceEpisodes: [] } }),
    );
    expect(res.status).toBe(200);
    expect(registry.get('learning/verify-node-version')?.metadata).toEqual({
      sourceEpisodes: ['episode-1'],
    });
  });

  it.each([
    {},
    { metadata: { a: 1 } },
    { body: '' },
    { body: ' '.repeat(5) },
    { body: 'x'.repeat(4001) },
    { description: 'x'.repeat(301) },
    { description: 'two\nlines' },
    { description: null },
  ])('rejects invalid edits %j', async (body) => {
    const app = createApp(await seededRegistry());
    for (const path of [
      '/v1/skills/learning/verify-node-version',
      '/v1/skills/verify-node-version',
    ]) {
      const response = await app.request(path, patch(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'validation_failed',
      });
    }
  });

  it('deletes a skill with its bookkeeping', async () => {
    const registry = await seededRegistry();
    const response = await createApp(registry).request(
      '/v1/skills/notes/shared',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: true,
      id: 'notes/shared',
      name: 'shared',
    });
    expect(registry.get('notes/shared')).toBeNull();
    expect(registry.get('learning/shared')).not.toBeNull();
  });

  it.each(['GET', 'PATCH', 'DELETE'])(
    'returns 404 for unknown skills on %s',
    async (method) => {
      const app = createApp(await seededRegistry());
      const init = method === 'PATCH' ? patch({ body: 'Edited.' }) : { method };
      for (const path of [
        '/v1/skills/learning/missing',
        '/v1/skills/unknown/shared',
        '/v1/skills/missing',
      ]) {
        const res = await app.request(path, init);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ code: 'not_found' });
      }
    },
  );

  it('resolves unique legacy names across namespaces', async () => {
    const registry = await seededRegistry();
    const app = createApp(registry);
    const res = await app.request('/v1/skills/verify-node-version');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'learning/verify-node-version',
      sourceEpisodes: ['episode-1'],
    });

    const edited = await app.request(
      '/v1/skills/verify-node-version',
      patch({ description: 'Edited.' }),
    );
    expect(await edited.json()).toMatchObject({
      description: 'Edited.',
      userEdited: true,
    });

    const deleted = await app.request('/v1/skills/verify-node-version', {
      method: 'DELETE',
    });
    expect(await deleted.json()).toEqual({
      deleted: true,
      id: 'learning/verify-node-version',
      name: 'verify-node-version',
    });
  });

  it.each(['GET', 'PATCH', 'DELETE'])(
    'returns 409 with candidates for ambiguous legacy names on %s',
    async (method) => {
      const registry = await seededRegistry();
      const init = method === 'PATCH' ? patch({ body: 'Edited.' }) : { method };
      const res = await createApp(registry).request('/v1/skills/shared', init);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'ambiguous_skill_name',
        candidates: ['learning/shared', 'notes/shared'],
      });
      expect(registry.get('learning/shared')?.body).toBe('L.');
      expect(registry.get('notes/shared')?.body).toBe('T.');
    },
  );

  it('replaces the template skill set', async () => {
    const registry = await seededRegistry();
    const app = createApp(registry);
    const first = await app.request(
      '/v1/skills/templates',
      put({ skills: [template('review'), template('deploy')] }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      currentTurn: 0,
      skills: [
        { id: 'templates/deploy', namespace: 'templates' },
        { id: 'templates/review', namespace: 'templates' },
      ],
    });

    await registry.recordRead('templates/review');
    await app.request(
      '/v1/skills/templates/deploy',
      patch({ body: 'Edited.' }),
    );
    registry.tick();
    const second = await app.request(
      '/v1/skills/templates',
      put({
        skills: [
          template('review'),
          template('deploy', 'New.'),
          template('triage'),
        ],
      }),
    );
    expect(second.status).toBe(200);
    expect(registry.get('templates/review')).toMatchObject({
      readCount: 1,
      updatedTurn: 0,
    });
    expect(registry.get('templates/deploy')).toMatchObject({
      body: 'New.',
      userEdited: false,
      updatedTurn: 1,
    });
    expect(registry.get('templates/triage')).toMatchObject({
      createdTurn: 1,
    });

    const third = await app.request(
      '/v1/skills/templates',
      put({ skills: [template('triage')] }),
    );
    expect(
      ((await third.json()) as { skills: { id: string }[] }).skills,
    ).toMatchObject([{ id: 'templates/triage' }]);
    expect(registry.get('templates/review')).toBeNull();
    expect(registry.get('templates/deploy')).toBeNull();
    expect(registry.get('learning/shared')).not.toBeNull();
    expect(registry.get('notes/shared')).not.toBeNull();

    const empty = await app.request(
      '/v1/skills/templates',
      put({ skills: [] }),
    );
    expect(empty.status).toBe(200);
    expect(registry.get('templates/triage')).toBeNull();
  });

  it.each([
    [{ name: 'review', description: 'D.' }],
    [template('Bad_Name')],
    [template('review'), template('review', 'Other.')],
    [{ ...template('review'), description: 'two\nlines' }],
    [template('review', 'x'.repeat(4001))],
  ])('rejects invalid template sets without writing %j', async (...skills) => {
    const registry = await seededRegistry();
    const app = createApp(registry);
    await app.request(
      '/v1/skills/templates',
      put({ skills: [template('existing')] }),
    );
    const response = await app.request(
      '/v1/skills/templates',
      put({ skills: [template('fresh'), ...skills] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'validation_failed',
    });
    expect(registry.get('templates/fresh')).toBeNull();
    expect(registry.get('templates/existing')).not.toBeNull();
  });

  it('rejects a template request without a skill list', async () => {
    const response = await createApp(await seededRegistry()).request(
      '/v1/skills/templates',
      put({}),
    );
    expect(response.status).toBe(400);
  });

  it('returns shared 500 errors for registry failures', async () => {
    const registry = await seededRegistry();
    registry.list = () => {
      throw new Error('registry failed');
    };
    registry.get = () => {
      throw new Error('registry failed');
    };
    registry.update = registry.delete = async () => {
      throw new Error('disk failed');
    };
    const app = createApp(registry);
    for (const [path, init] of [
      ['/v1/skills', {}],
      ['/v1/skills/learning/shared', {}],
      ['/v1/skills/learning/shared', patch({ body: 'Edited.' })],
      ['/v1/skills/learning/shared', { method: 'DELETE' }],
    ] as const) {
      const response = await app.request(path, init);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: 'internal_error' });
    }
  });
});
