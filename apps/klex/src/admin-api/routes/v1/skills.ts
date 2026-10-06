import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type {
  CatalogSkill,
  SkillCatalog,
} from '@/session/chat/extensions/learning';

import {
  errorResponseSchema,
  skillDetailSchema,
  skillListResponseSchema,
  skillNameParamsSchema,
} from './schemas';

export interface SkillsRouteDependencies {
  skillCatalog: SkillCatalog;
}

const NOT_RUNNING = {
  error:
    'Skills are not available because the learning extension is not running',
  code: 'not_running',
} as const;

export const listSkillsRoute = createRoute({
  method: 'get',
  path: '/v1/skills',
  tags: ['Skills'],
  summary: 'List skills',
  description:
    "Lists the agent's skills with their name, description, origin, and usage bookkeeping. Bodies are omitted; fetch a single skill for its body.",
  responses: {
    200: {
      content: {
        'application/json': { schema: skillListResponseSchema },
      },
      description: 'Skill summaries, sorted by name',
    },
    503: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Learning extension is not running',
    },
  },
});

export function listSkills(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof listSkillsRoute> {
  return (c) => {
    if (!deps.skillCatalog.isAvailable()) return c.json(NOT_RUNNING, 503);
    const skills = [...deps.skillCatalog.list()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => toSummary(deps.skillCatalog, skill));
    return c.json({ skills }, 200);
  };
}

export const getSkillRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{name}',
  tags: ['Skills'],
  summary: 'Get a skill',
  description:
    'Returns one skill including its SKILL.md body and the memory episodes it was learned from.',
  request: {
    params: skillNameParamsSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: skillDetailSchema },
      },
      description: 'Skill detail',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Skill not found',
    },
    503: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Learning extension is not running',
    },
  },
});

export function getSkill(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof getSkillRoute> {
  return (c) => {
    if (!deps.skillCatalog.isAvailable()) return c.json(NOT_RUNNING, 503);
    const { name } = c.req.valid('param');
    const skill = deps.skillCatalog.get(name);
    if (!skill) {
      return c.json(
        { error: `Skill "${name}" not found`, code: 'not_found' },
        404,
      );
    }
    const usage = deps.skillCatalog.getUsage(skill.name);
    return c.json(
      {
        ...toSummary(deps.skillCatalog, skill),
        body: skill.body,
        ...(usage ? { sourceEpisodes: [...usage.sourceEpisodes] } : {}),
      },
      200,
    );
  };
}

function toSummary(catalog: SkillCatalog, skill: CatalogSkill) {
  const usage = catalog.getUsage(skill.name);
  return {
    name: skill.name,
    description: skill.description,
    origin: skill.origin,
    ...(usage
      ? {
          createdAt: usage.createdAt,
          updatedAt: usage.updatedAt,
          lastReadAt: usage.lastReadAt,
          readCount: usage.readCount,
        }
      : {}),
  };
}
