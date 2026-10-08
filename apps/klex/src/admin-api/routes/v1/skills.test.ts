import { describe, expect, it } from 'vitest';

import type {
  CatalogSkill,
  SkillCatalog,
  SkillUsage,
} from '@/session/chat/extensions/learning/skill-store';

import { getSkill, getSkillRoute, listSkills, listSkillsRoute } from './skills';
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
  });
}

describe('skills routes', () => {
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
