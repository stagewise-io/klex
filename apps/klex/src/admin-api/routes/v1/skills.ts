import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import {
  formatSkillId,
  type Skill,
  type SkillRegistry,
  SkillValidationError,
} from '@/skills';

import {
  ambiguousSkillResponseSchema,
  deleteSkillResponseSchema,
  errorResponseSchema,
  replaceTemplateSkillsBodySchema,
  skillDetailSchema,
  skillIdParamsSchema,
  skillListResponseSchema,
  skillNameParamsSchema,
  updateSkillBodySchema,
} from './schemas';

export interface SkillsRouteDependencies {
  skillRegistry: SkillRegistry;
}

const LEARNING_NAMESPACE = 'learning';

const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: errorResponseSchema } },
  description,
});

const detailResponses = {
  200: {
    content: { 'application/json': { schema: skillDetailSchema } },
    description: 'Skill detail',
  },
  404: errorResponse('Skill not found'),
  500: errorResponse('Internal server error'),
};

// LEGACY(skill-registry): only the bare-name routes answer 409.
const ambiguousResponse = {
  409: {
    content: { 'application/json': { schema: ambiguousSkillResponseSchema } },
    description: 'The name exists in more than one namespace',
  },
};

const editRequest = {
  required: true,
  content: { 'application/json': { schema: updateSkillBodySchema } },
};

const deleteResponses = {
  ...detailResponses,
  200: {
    description: 'Skill deleted',
    content: { 'application/json': { schema: deleteSkillResponseSchema } },
  },
};

export const listSkillsRoute = createRoute({
  method: 'get',
  path: '/v1/skills',
  tags: ['Skills'],
  summary: 'List skills',
  description:
    "Lists the agent's skills of every namespace with description, source, usage bookkeeping and metadata. Bodies are omitted; fetch a single skill for its body.",
  responses: {
    200: {
      content: {
        'application/json': { schema: skillListResponseSchema },
      },
      description: 'Skill summaries, sorted by id',
    },
    500: errorResponse('Internal server error'),
  },
});

export function listSkills(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof listSkillsRoute> {
  return (c) =>
    c.json(
      {
        skills: deps.skillRegistry.list().map(toSummary),
        currentTurn: deps.skillRegistry.currentTurn(),
      },
      200,
    );
}

export const getSkillRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{namespace}/{name}',
  tags: ['Skills'],
  summary: 'Get a skill',
  description: 'Returns one skill including its SKILL.md body.',
  request: { params: skillIdParamsSchema },
  responses: detailResponses,
});

export function getSkill(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof getSkillRoute> {
  return (c) => {
    const { namespace, name } = c.req.valid('param');
    const id = formatSkillId(namespace, name);
    const skill = deps.skillRegistry.get(id);
    if (!skill) return c.json(notFound(id), 404);
    return c.json(toDetail(deps.skillRegistry, skill), 200);
  };
}

export const updateSkillRoute = createRoute({
  method: 'patch',
  path: '/v1/skills/{namespace}/{name}',
  tags: ['Skills'],
  summary: 'Edit a skill',
  description:
    'Edits description or body of a skill in any namespace and marks it user-edited. Metadata is read-only.',
  request: { params: skillIdParamsSchema, body: editRequest },
  responses: {
    ...detailResponses,
    400: errorResponse('Invalid skill edit'),
  },
});

export function updateSkill(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof updateSkillRoute> {
  return async (c) => {
    const { namespace, name } = c.req.valid('param');
    const id = formatSkillId(namespace, name);
    try {
      const skill = await deps.skillRegistry.update(id, c.req.valid('json'));
      if (!skill) return c.json(notFound(id), 404);
      return c.json(toDetail(deps.skillRegistry, skill), 200);
    } catch (error) {
      if (error instanceof SkillValidationError)
        return c.json({ error: error.message, code: 'validation_failed' }, 400);
      throw error;
    }
  };
}

export const deleteSkillRoute = createRoute({
  method: 'delete',
  path: '/v1/skills/{namespace}/{name}',
  tags: ['Skills'],
  summary: 'Delete a skill',
  description: 'Deletes a skill of any namespace with its bookkeeping.',
  request: { params: skillIdParamsSchema },
  responses: deleteResponses,
});

export function deleteSkill(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof deleteSkillRoute> {
  return async (c) => {
    const { namespace, name } = c.req.valid('param');
    const id = formatSkillId(namespace, name);
    if (!(await deps.skillRegistry.delete(id)))
      return c.json(notFound(id), 404);
    return c.json({ deleted: true as const, id, name }, 200);
  };
}

export const replaceTemplateSkillsRoute = createRoute({
  method: 'put',
  path: '/v1/skills/templates',
  tags: ['Skills'],
  summary: 'Replace template skills',
  description:
    'Makes the `templates` namespace hold exactly the given skills: creates new ones, rewrites changed ones and deletes missing ones. Unchanged skills keep their usage; rewritten ones are no longer user-edited. Validates the whole set before writing.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: replaceTemplateSkillsBodySchema },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: skillListResponseSchema } },
      description: 'Template skill summaries, sorted by id',
    },
    400: errorResponse('Invalid template skills'),
    500: errorResponse('Internal server error'),
  },
});

export function replaceTemplateSkills(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof replaceTemplateSkillsRoute> {
  return async (c) => {
    try {
      const skills = await deps.skillRegistry.replaceTemplateSkills(
        c.req.valid('json').skills,
      );
      return c.json(
        {
          skills: skills.map(toSummary),
          currentTurn: deps.skillRegistry.currentTurn(),
        },
        200,
      );
    } catch (error) {
      if (error instanceof SkillValidationError)
        return c.json({ error: error.message, code: 'validation_failed' }, 400);
      throw error;
    }
  };
}

// --- Legacy bare-name routes ---

// LEGACY(skill-registry): kept for clients that do not send a namespace,
// such as Cloud talking to bots older than Klex 0.28.0. Remove after Cloud no
// longer calls them. Removing them is a breaking Admin API change, so commit it
// with the `klex,agent-admin-api` scopes. Also remove `resolve`,
// `ambiguousResponse`, `skillNameParamsSchema`,
// `ambiguousSkillResponseSchema` and the registrations in `server.ts`. Keep
// `SkillRegistry.resolveName`: session `readSkill` errors use it for hints.

export const getLegacySkillRoute = createRoute({
  method: 'get',
  path: '/v1/skills/{name}',
  tags: ['Skills'],
  summary: 'Get a skill by bare name',
  description:
    'Deprecated: use `/v1/skills/{namespace}/{name}`. Resolves the name across namespaces.',
  deprecated: true,
  request: { params: skillNameParamsSchema },
  responses: { ...detailResponses, ...ambiguousResponse },
});

export function getLegacySkill(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof getLegacySkillRoute> {
  return (c) => {
    const { name } = c.req.valid('param');
    const resolved = resolve(deps.skillRegistry, name);
    if (resolved.status === 404) return c.json(resolved.body, 404);
    if (resolved.status === 409) return c.json(resolved.body, 409);
    return c.json(toDetail(deps.skillRegistry, resolved.skill), 200);
  };
}

export const updateLegacySkillRoute = createRoute({
  method: 'patch',
  path: '/v1/skills/{name}',
  tags: ['Skills'],
  summary: 'Edit a skill by bare name',
  description:
    'Deprecated: use `/v1/skills/{namespace}/{name}`. Resolves the name across namespaces.',
  deprecated: true,
  request: { params: skillNameParamsSchema, body: editRequest },
  responses: {
    ...detailResponses,
    ...ambiguousResponse,
    400: errorResponse('Invalid skill edit'),
  },
});

export function updateLegacySkill(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof updateLegacySkillRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');
    const resolved = resolve(deps.skillRegistry, name);
    if (resolved.status === 404) return c.json(resolved.body, 404);
    if (resolved.status === 409) return c.json(resolved.body, 409);
    const { id } = resolved.skill;
    try {
      const skill = await deps.skillRegistry.update(id, c.req.valid('json'));
      if (!skill) return c.json(notFound(id), 404);
      return c.json(toDetail(deps.skillRegistry, skill), 200);
    } catch (error) {
      if (error instanceof SkillValidationError)
        return c.json({ error: error.message, code: 'validation_failed' }, 400);
      throw error;
    }
  };
}

export const deleteLegacySkillRoute = createRoute({
  method: 'delete',
  path: '/v1/skills/{name}',
  tags: ['Skills'],
  summary: 'Delete a skill by bare name',
  description:
    'Deprecated: use `/v1/skills/{namespace}/{name}`. Resolves the name across namespaces.',
  deprecated: true,
  request: { params: skillNameParamsSchema },
  responses: { ...deleteResponses, ...ambiguousResponse },
});

export function deleteLegacySkill(
  deps: SkillsRouteDependencies,
): RouteHandler<typeof deleteLegacySkillRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');
    const resolved = resolve(deps.skillRegistry, name);
    if (resolved.status === 404) return c.json(resolved.body, 404);
    if (resolved.status === 409) return c.json(resolved.body, 409);
    const { id } = resolved.skill;
    if (!(await deps.skillRegistry.delete(id)))
      return c.json(notFound(id), 404);
    return c.json({ deleted: true as const, id, name }, 200);
  };
}

// --- Helpers ---

type Resolution =
  | { status: 200; skill: Skill }
  | { status: 404; body: { error: string; code: string } }
  | {
      status: 409;
      body: { error: string; code: string; candidates: string[] };
    };

function resolve(registry: SkillRegistry, name: string): Resolution {
  const matches = registry.resolveName(name);
  const [only] = matches;
  if (!only) return { status: 404, body: notFound(name) };
  if (matches.length > 1) {
    const candidates = matches.map((skill) => skill.id);
    return {
      status: 409,
      body: {
        error: `Skill name "${name}" exists in several namespaces: ${candidates.join(', ')}`,
        code: 'ambiguous_skill_name',
        candidates,
      },
    };
  }
  return { status: 200, skill: only };
}

function notFound(skill: string) {
  return { error: `Skill "${skill}" not found`, code: 'not_found' };
}

function toSummary(skill: Skill) {
  return {
    id: skill.id,
    namespace: skill.namespace,
    name: skill.name,
    description: skill.description,
    // LEGACY(skill-registry): deprecated field, see `skillSummarySchema`.
    origin:
      skill.namespace === LEARNING_NAMESPACE ? 'learned' : skill.namespace,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    lastReadAt: skill.lastReadAt,
    readCount: skill.readCount,
    createdTurn: skill.createdTurn,
    updatedTurn: skill.updatedTurn,
    lastReadTurn: skill.lastReadTurn,
    userEdited: skill.userEdited,
    metadata: skill.metadata,
  };
}

function toDetail(registry: SkillRegistry, skill: Skill) {
  const { sourceEpisodes } = skill.metadata;
  return {
    ...toSummary(skill),
    body: skill.body,
    // LEGACY(skill-registry): deprecated field, see `skillDetailSchema`.
    sourceEpisodes:
      Array.isArray(sourceEpisodes) &&
      sourceEpisodes.every((episode) => typeof episode === 'string')
        ? sourceEpisodes
        : [],
    currentTurn: registry.currentTurn(),
  };
}
