import { describe, expect, it } from 'vitest';

import type {
  CatalogSkill,
  SkillCatalog,
  SkillUsage,
} from '@/session/chat/extensions/learning/skill-store';
import { SkillValidationError } from '@/session/chat/extensions/learning/skill-store';

import {
  deleteSkill,
  deleteSkillRoute,
  getSkill,
  getSkillRoute,
  listSkills,
  listSkillsRoute,
  updateSkill,
  updateSkillRoute,
} from './skills';
import { setupTestApp } from './test-utils';

const tracked: CatalogSkill = {
  name: 'verify-node-version',
  description: 'Use before running tests on a VM.',
  body: 'Run `nvm use` first.',
  origin: 'learned',
};
const untracked: CatalogSkill = {
  name: 'ask-before-contract-changes',
  description: 'Use before changing a published protocol field.',
  body: 'Ask the team first.',
  origin: 'learned',
};
const usage: SkillUsage = {
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  lastReadAt: null,
  readCount: 0,
  sourceEpisodes: ['episode-1'],
};

function createCatalog(available = true): SkillCatalog {
  const skills = [tracked, untracked];
  return {
    update: async (name, patch) => {
      const skill = skills.find((skill) => skill.name === name);
      return skill ? { ...skill, ...patch } : null;
    },
    delete: async (name) => skills.some((skill) => skill.name === name),
    isAvailable: () => available,
    list: () => skills,
    get: (name) => skills.find((skill) => skill.name === name) ?? null,
    getUsage: (name) => (name === tracked.name ? usage : null),
  };
}

function createApp(skillCatalog: SkillCatalog) {
  return setupTestApp((app) => {
    app.openapi(listSkillsRoute, listSkills({ skillCatalog }));
    app.openapi(getSkillRoute, getSkill({ skillCatalog }));
    app.openapi(updateSkillRoute, updateSkill({ skillCatalog }));
    app.openapi(deleteSkillRoute, deleteSkill({ skillCatalog }));
  });
}

describe('skills routes', () => {
  it('updates a skill and returns its detail and provenance', async () => {
    const response = await createApp(createCatalog()).request(
      `/v1/skills/${tracked.name}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '  Edited.  ' }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body: 'Edited.',
      description: tracked.description,
      sourceEpisodes: usage.sourceEpisodes,
    });
  });

  it.each([
    {},
    { body: '' },
    { body: ' '.repeat(5) },
    { body: 'x'.repeat(4001) },
    { description: 'x'.repeat(301) },
    { description: 'two\nlines' },
    { description: null },
  ])('rejects invalid edits %j', async (body) => {
    const response = await createApp(createCatalog()).request(
      `/v1/skills/${tracked.name}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'validation_failed' });
  });

  it.each(['PATCH', 'DELETE'])(
    'handles missing, unavailable, and failed %s requests',
    async (method) => {
      const request = {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'PATCH'
          ? { body: JSON.stringify({ body: 'Edited.' }) }
          : {}),
      };
      expect(
        (
          await createApp(createCatalog()).request(
            '/v1/skills/missing',
            request,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await createApp(createCatalog(false)).request(
            `/v1/skills/${tracked.name}`,
            request,
          )
        ).status,
      ).toBe(503);
      const catalog = createCatalog();
      catalog.update = catalog.delete = async () => {
        throw new Error('disk failed');
      };
      expect(
        (
          await createApp(catalog).request(
            `/v1/skills/${tracked.name}`,
            request,
          )
        ).status,
      ).toBe(500);
    },
  );

  it('maps catalog validation errors to 400', async () => {
    const catalog = createCatalog();
    catalog.update = async () => {
      throw new SkillValidationError('invalid skill');
    };
    const response = await createApp(catalog).request(
      `/v1/skills/${tracked.name}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'Edited.' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid skill',
      code: 'validation_failed',
    });
  });

  it('deletes a skill', async () => {
    const response = await createApp(createCatalog()).request(
      `/v1/skills/${tracked.name}`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: true,
      name: tracked.name,
    });
  });
  it('declares and returns shared 500 errors for catalog failures', async () => {
    const catalog = createCatalog();
    catalog.list = () => {
      throw new Error('catalog failed');
    };
    catalog.get = () => {
      throw new Error('catalog failed');
    };
    expect(listSkillsRoute.responses[500]).toBeDefined();
    expect(getSkillRoute.responses[500]).toBeDefined();
    const app = createApp(catalog);
    for (const path of ['/v1/skills', `/v1/skills/${tracked.name}`]) {
      const response = await app.request(path);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: expect.any(String),
        code: 'internal_error',
      });
    }
  });

  it('lists skill summaries sorted by name without bodies', async () => {
    const res = await createApp(createCatalog()).request('/v1/skills');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nextCursor: null,
      skills: [
        {
          name: untracked.name,
          description: untracked.description,
          origin: 'learned',
        },
        {
          name: tracked.name,
          description: tracked.description,
          origin: 'learned',
          createdAt: usage.createdAt,
          updatedAt: usage.updatedAt,
          lastReadAt: null,
          readCount: 0,
        },
      ],
    });
  });

  it('paginates matches and continues after the cursor skill is deleted', async () => {
    const catalog = createCatalog();
    const skills = Array.from({ length: 5 }, (_, index) => ({
      ...untracked,
      name: `skill-${index}`,
      description:
        index % 2 === 0 ? 'Verify FRONTEND changes.' : 'Backend changes.',
    }));
    catalog.list = () => skills;
    const app = createApp(catalog);
    const first = await app.request('/v1/skills?limit=2&search=%20frontend%20');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      skills: [{ name: 'skill-0' }, { name: 'skill-2' }],
      nextCursor: 'skill-2',
    });
    skills.splice(2, 1);
    const last = await app.request(
      '/v1/skills?limit=2&search=frontend&cursor=skill-2',
    );
    expect(await last.json()).toMatchObject({
      skills: [{ name: 'skill-4' }],
      nextCursor: null,
    });
    const empty = await app.request('/v1/skills?limit=2&search=missing');
    expect(await empty.json()).toEqual({ skills: [], nextCursor: null });
  });

  it.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=nope', 'cursor='])(
    'rejects invalid pagination parameters: %s',
    async (query) => {
      const response = await createApp(createCatalog()).request(
        `/v1/skills?${query}`,
      );
      expect(response.status).toBe(400);
    },
  );

  it('returns a skill with body and source episodes', async () => {
    const res = await createApp(createCatalog()).request(
      `/v1/skills/${tracked.name}`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: tracked.name,
      description: tracked.description,
      origin: 'learned',
      createdAt: usage.createdAt,
      updatedAt: usage.updatedAt,
      lastReadAt: null,
      readCount: 0,
      body: tracked.body,
      sourceEpisodes: ['episode-1'],
    });
  });

  it('omits usage fields for a skill without learning state', async () => {
    const res = await createApp(createCatalog()).request(
      `/v1/skills/${untracked.name}`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: untracked.name,
      description: untracked.description,
      origin: 'learned',
      body: untracked.body,
    });
  });

  it('returns 404 for an unknown skill', async () => {
    const res = await createApp(createCatalog()).request('/v1/skills/missing');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
  });

  it('returns 503 when the learning extension is not running', async () => {
    const app = createApp(createCatalog(false));

    for (const path of ['/v1/skills', `/v1/skills/${tracked.name}`]) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'not_running' });
    }
  });
});
