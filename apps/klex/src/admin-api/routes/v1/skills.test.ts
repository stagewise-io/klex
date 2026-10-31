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
  registry.claimNamespace('example.templates', 'templates');
  const learning = registry.forNamespace('learning');
  await learning.put(
    'verify-node-version',
    { description: 'Use before running tests on a VM.', body: 'Run nvm use.' },
    { metadata: { sourceEpisodes: ['episode-1'] } },
  );
  await learning.put('shared', { description: 'Learned.', body: 'L.' });
  await registry
    .forNamespace('templates')
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
      ['templates/shared', 'templates'],
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

    const templated = await app.request('/v1/skills/templates/shared');
    expect(await templated.json()).toMatchObject({
      origin: 'templates',
      sourceEpisodes: [],
      metadata: { sourceEpisodes: 'not-a-list', template: 'x' },
    });
  });

  it('edits skills of any namespace and marks them user-edited', async () => {
    const registry = await seededRegistry();
    const res = await createApp(registry).request(
      '/v1/skills/templates/shared',
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
      '/v1/skills/templates/shared',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: true,
      id: 'templates/shared',
      name: 'shared',
    });
    expect(registry.get('templates/shared')).toBeNull();
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
        candidates: ['learning/shared', 'templates/shared'],
      });
      expect(registry.get('learning/shared')?.body).toBe('L.');
      expect(registry.get('templates/shared')?.body).toBe('T.');
    },
  );

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
