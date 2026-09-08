import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  ProviderInstanceInfo,
  ProviderMetadata,
  ProviderOperationFailure,
  ProviderRegistry,
  ProviderTypeInfo,
  ResolvedProviderModel,
} from '@/provider-registry';

import {
  canAddProviderBodySchema,
  connectivityResultSchema,
  createKnownModelBodySchema,
  createProviderBodySchema,
  errorResponseSchema,
  knownModelIdParamSchema,
  providerIdParamSchema,
  providerModelsQuerySchema,
  providerModelsResponseSchema,
  providerOperationSchema,
  providersResponseSchema,
  providerTypeParamSchema,
  providerTypesResponseSchema,
  updateKnownModelBodySchema,
  updateProviderBodySchema,
} from './schemas';

export interface ProviderRouteDependencies {
  providerRegistry: ProviderRegistry;
  logger: ModuleLogger;
}

const failureStatus = (
  failure: ProviderOperationFailure,
): 400 | 404 | 409 | 500 => {
  if (failure.code === 'not_found') return 404;
  if (failure.code === 'conflict' || failure.code === 'referential_integrity')
    return 409;
  if (failure.code === 'internal_error') return 500;
  return 400;
};

const failureBody = (failure: ProviderOperationFailure) => ({
  error: failure.message,
  code: failure.code,
  ...(failure.remediation && { remediation: failure.remediation }),
});

function serializeMetadata(metadata: ProviderMetadata) {
  return {
    ...metadata,
    capabilities: { ...metadata.capabilities },
  };
}

function serializeType(info: ProviderTypeInfo) {
  return {
    ...serializeMetadata(info),
    type: info.type,
    settingsSchema: structuredClone(info.settingsSchema),
  };
}

function serializeInstance(info: ProviderInstanceInfo) {
  return {
    ...info,
    settings: { ...info.settings },
    metadata: serializeMetadata(info.metadata),
  };
}

function serializeModels(models: readonly ResolvedProviderModel[]) {
  return models.map((model) => ({ ...model }));
}

export const getProviderTypesRoute = createRoute({
  method: 'get',
  path: '/v1/provider-types',
  tags: ['Providers'],
  summary: 'List provider types',
  responses: {
    200: {
      content: { 'application/json': { schema: providerTypesResponseSchema } },
      description: 'Registered provider types',
    },
  },
});
export function getProviderTypes(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof getProviderTypesRoute> {
  return (c) =>
    c.json(
      {
        providerTypes: deps.providerRegistry
          .listProviderTypes()
          .map(serializeType),
      },
      200,
    );
}

export const canAddProviderRoute = createRoute({
  method: 'post',
  path: '/v1/provider-types/{type}/can-add',
  tags: ['Providers'],
  summary: 'Check provider prerequisites',
  request: {
    params: providerTypeParamSchema,
    body: {
      content: { 'application/json': { schema: canAddProviderBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerOperationSchema } },
      description: 'Provider may be added',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider is blocked or invalid',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal error',
    },
  },
});
export function canAddProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof canAddProviderRoute> {
  return async (c) => {
    const result = await deps.providerRegistry.preflightCreate(
      c.req.valid('param').type,
      c.req.valid('json').settings,
    );
    if (result.ok) return c.json({ ok: true }, 200);
    const status = failureStatus(result);
    if (status === 500) return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const getProvidersRoute = createRoute({
  method: 'get',
  path: '/v1/providers',
  tags: ['Providers'],
  summary: 'List provider instances',
  responses: {
    200: {
      content: { 'application/json': { schema: providersResponseSchema } },
      description: 'Configured provider instances',
    },
  },
});
export function getProviders(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof getProvidersRoute> {
  return (c) =>
    c.json(
      {
        providers: deps.providerRegistry.listInstances().map(serializeInstance),
      },
      200,
    );
}

export const createProviderRoute = createRoute({
  method: 'post',
  path: '/v1/providers',
  tags: ['Providers'],
  summary: 'Create provider instance',
  request: {
    body: {
      content: { 'application/json': { schema: createProviderBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: providerOperationSchema } },
      description: 'Provider created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid or blocked',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'ID exists',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal error',
    },
  },
});
export function createProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof createProviderRoute> {
  return async (c) => {
    const body = c.req.valid('json');
    const result = await deps.providerRegistry.addInstance(body);
    if (result.ok)
      return c.json(
        { ok: true, provider: serializeInstance(result.value) },
        201,
      );
    const status = failureStatus(result);
    if (status === 409) return c.json(failureBody(result), 409);
    if (status === 500) return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const updateProviderRoute = createRoute({
  method: 'patch',
  path: '/v1/providers/{id}',
  tags: ['Providers'],
  summary: 'Update provider instance',
  request: {
    params: providerIdParamSchema,
    body: {
      content: {
        'application/merge-patch+json': { schema: updateProviderBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerOperationSchema } },
      description: 'Provider updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid or blocked',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Not found',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal error',
    },
  },
});
export function updateProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof updateProviderRoute> {
  return async (c) => {
    const result = await deps.providerRegistry.updateInstance(
      c.req.valid('param').id,
      c.req.valid('json'),
    );
    if (result.ok)
      return c.json(
        { ok: true, provider: serializeInstance(result.value) },
        200,
      );
    const status = failureStatus(result);
    if (status === 404) return c.json(failureBody(result), 404);
    if (status === 500) return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const deleteProviderRoute = createRoute({
  method: 'delete',
  path: '/v1/providers/{id}',
  tags: ['Providers'],
  summary: 'Delete provider instance',
  request: { params: providerIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerOperationSchema } },
      description: 'Provider deleted',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Blocked',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider is in use',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal error',
    },
  },
});
export function deleteProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof deleteProviderRoute> {
  return async (c) => {
    const result = await deps.providerRegistry.removeInstance(
      c.req.valid('param').id,
    );
    if (result.ok) return c.json({ ok: true }, 200);
    const status = failureStatus(result);
    if (status === 404) return c.json(failureBody(result), 404);
    if (status === 409) return c.json(failureBody(result), 409);
    if (status === 500) return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const testProviderRoute = createRoute({
  method: 'post',
  path: '/v1/providers/{id}/test',
  tags: ['Providers'],
  summary: 'Test provider connectivity',
  request: { params: providerIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: connectivityResultSchema } },
      description: 'Connectivity result',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Connectivity test failed',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Not found',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal provider error',
    },
  },
});
export function testProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof testProviderRoute> {
  return async (c) => {
    const result = await deps.providerRegistry.testConnection(
      c.req.valid('param').id,
    );
    if (result.ok) return c.json(result.value, 200);
    if (result.code === 'not_found') return c.json(failureBody(result), 404);
    if (result.code === 'internal_error')
      return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const getProviderModelsRoute = createRoute({
  method: 'get',
  path: '/v1/providers/{id}/models',
  tags: ['Providers'],
  summary: 'List known and discovered models',
  request: {
    params: providerIdParamSchema,
    query: providerModelsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerModelsResponseSchema } },
      description: 'Available models',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Model discovery failed',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Not found',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal provider error',
    },
  },
});
export function getProviderModels(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof getProviderModelsRoute> {
  return async (c) => {
    const result = await deps.providerRegistry.listModels(
      c.req.valid('param').id,
      c.req.valid('query').refresh === 'true',
    );
    if (result.ok)
      return c.json({ models: serializeModels(result.value) }, 200);
    if (result.code === 'not_found') return c.json(failureBody(result), 404);
    if (result.code === 'internal_error')
      return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const createKnownModelRoute = createRoute({
  method: 'post',
  path: '/v1/providers/{id}/models',
  tags: ['Providers'],
  summary: 'Add a manual known model',
  request: {
    params: providerIdParamSchema,
    body: {
      content: { 'application/json': { schema: createKnownModelBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerModelsResponseSchema } },
      description: 'Updated models',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Model discovery failed',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Model already exists',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Persistence failed',
    },
  },
});
export function createKnownModel(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof createKnownModelRoute> {
  return async (c) => {
    const { id } = c.req.valid('param');
    const { modelId, ...definition } = c.req.valid('json');
    const changed = await deps.providerRegistry.addKnownModel(
      id,
      modelId,
      definition,
    );
    if (!changed.ok) {
      if (changed.code === 'conflict') return c.json(failureBody(changed), 409);
      if (changed.code === 'internal_error')
        return c.json(failureBody(changed), 500);
      return c.json(failureBody(changed), 404);
    }
    const result = await deps.providerRegistry.listModels(id);
    if (result.ok)
      return c.json({ models: serializeModels(result.value) }, 200);
    if (result.code === 'internal_error')
      return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const updateKnownModelRoute = createRoute({
  method: 'patch',
  path: '/v1/providers/{id}/models/{modelId}',
  tags: ['Providers'],
  summary: 'Update a manual known model',
  request: {
    params: knownModelIdParamSchema,
    body: {
      content: { 'application/json': { schema: updateKnownModelBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerModelsResponseSchema } },
      description: 'Updated models',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Model discovery failed',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider or model not found',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Persistence failed',
    },
  },
});
export function updateKnownModel(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof updateKnownModelRoute> {
  return async (c) => {
    const { id, modelId } = c.req.valid('param');
    const changed = await deps.providerRegistry.updateKnownModel(
      id,
      modelId,
      c.req.valid('json'),
    );
    if (!changed.ok) {
      if (changed.code === 'internal_error')
        return c.json(failureBody(changed), 500);
      return c.json(failureBody(changed), 404);
    }
    const result = await deps.providerRegistry.listModels(id);
    if (result.ok)
      return c.json({ models: serializeModels(result.value) }, 200);
    if (result.code === 'internal_error')
      return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}

export const deleteKnownModelRoute = createRoute({
  method: 'delete',
  path: '/v1/providers/{id}/models/{modelId}',
  tags: ['Providers'],
  summary: 'Delete a manual known model',
  request: { params: knownModelIdParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerModelsResponseSchema } },
      description: 'Updated models',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Model discovery failed',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider or model not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Model is referenced by model selection',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Persistence failed',
    },
  },
});
export function deleteKnownModel(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof deleteKnownModelRoute> {
  return async (c) => {
    const { id, modelId } = c.req.valid('param');
    const changed = await deps.providerRegistry.removeKnownModel(id, modelId);
    if (!changed.ok) {
      if (changed.code === 'conflict') return c.json(failureBody(changed), 409);
      if (changed.code === 'internal_error')
        return c.json(failureBody(changed), 500);
      return c.json(failureBody(changed), 404);
    }
    const result = await deps.providerRegistry.listModels(id);
    if (result.ok)
      return c.json({ models: serializeModels(result.value) }, 200);
    if (result.code === 'internal_error')
      return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 400);
  };
}
