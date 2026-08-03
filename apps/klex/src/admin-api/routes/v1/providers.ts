import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  Config,
  EndpointAuth,
  EndpointConfig,
  ManualEndpoint,
  ModelDefinition,
  ModelInputCapabilities,
  ProviderConfig,
} from '@/config';
import { ConfigValidationError } from '@/config';

import {
  createEndpointBodySchema,
  createKnownModelBodySchema,
  createProviderBodySchema,
  endpointNameParamSchema,
  endpointsResponseSchema,
  errorResponseSchema,
  knownModelIdParamSchema,
  knownModelQuerySchema,
  knownModelsResponseSchema,
  providerNameParamSchema,
  providersResponseSchema,
  updateEndpointBodySchema,
  updateKnownModelBodySchema,
  updateProviderBodySchema,
} from './schemas';

export interface ProviderRouteDependencies {
  config: Config;
  logger: ModuleLogger;
}

// --- GET /v1/providers ---

export const getProvidersRoute = createRoute({
  method: 'get',
  path: '/v1/providers',
  tags: ['Providers'],
  summary: 'List all providers',
  description:
    'Returns all configured model providers, including both preset and manual providers.',
  responses: {
    200: {
      content: {
        'application/json': { schema: providersResponseSchema },
      },
      description: 'List of configured providers',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getProviders(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof getProvidersRoute> {
  return (c) => {
    return c.json({ providers: getProviderList(deps) }, 200);
  };
}

// --- POST /v1/providers ---

export const createProviderRoute = createRoute({
  method: 'post',
  path: '/v1/providers',
  tags: ['Providers'],
  summary: 'Add a new provider',
  description:
    'Adds a new model provider. The provider name must be unique. The body must be either a preset provider (with preset and auth) or a manual provider (with endpoints).',
  request: {
    body: {
      content: {
        'application/json': { schema: createProviderBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': { schema: providersResponseSchema },
      },
      description: 'Provider created — returns updated provider list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid request body',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'A provider with this name already exists',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function createProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof createProviderRoute> {
  return async (c) => {
    const body = c.req.valid('json');
    const { name, ...providerConfig } = body;
    const provider = providerConfig as ProviderConfig;

    try {
      await deps.config.addProvider(name, provider);
      return c.json({ providers: getProviderList(deps) }, 201);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'already_exists')
          return c.json({ error: error.message }, 409);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Provider create failed');
      return c.json({ error: 'Failed to create provider' }, 500);
    }
  };
}

// --- PATCH /v1/providers/{name} ---

export const updateProviderRoute = createRoute({
  method: 'patch',
  path: '/v1/providers/{name}',
  tags: ['Providers'],
  summary: 'Partially update a provider',
  description:
    'Partially updates an existing provider. For preset providers, preset and auth can be updated. For manual providers, endpoints can be updated. Only provided fields are applied; omitted fields preserve current values.',
  request: {
    params: providerNameParamSchema,
    body: {
      content: {
        'application/json': { schema: updateProviderBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: providersResponseSchema },
      },
      description: 'Provider updated — returns updated provider list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid request body',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function updateProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof updateProviderRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');
    const patch = c.req.valid('json');

    try {
      await deps.config.mutate((current) => {
        const existing = current.providers[name];
        if (!existing) {
          throw new ConfigValidationError(`Provider '${name}' not found`, {
            code: 'not_found',
          });
        }
        const merged = mergeProviderPatch(existing, patch);
        return {
          ...current,
          providers: { ...current.providers, [name]: merged },
        };
      });
      return c.json({ providers: getProviderList(deps) }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Provider update failed');
      return c.json({ error: 'Failed to update provider' }, 500);
    }
  };
}

// --- DELETE /v1/providers/{name} ---

export const deleteProviderRoute = createRoute({
  method: 'delete',
  path: '/v1/providers/{name}',
  tags: ['Providers'],
  summary: 'Delete a provider',
  description:
    'Removes a provider and all of its endpoints and known models from the configuration.',
  request: {
    params: providerNameParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: providersResponseSchema },
      },
      description: 'Provider removed — returns updated provider list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Validation error',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider not found',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description:
        'Provider is referenced by model selection and cannot be deleted',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function deleteProvider(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof deleteProviderRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');

    try {
      await deps.config.removeProvider(name);
      return c.json({ providers: getProviderList(deps) }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        if (error.code === 'referential_integrity')
          return c.json({ error: error.message }, 409);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Provider delete failed');
      return c.json({ error: 'Failed to delete provider' }, 500);
    }
  };
}

// --- GET /v1/providers/{name}/endpoints ---

export const getEndpointsRoute = createRoute({
  method: 'get',
  path: '/v1/providers/{name}/endpoints',
  tags: ['Providers'],
  summary: 'List endpoints of a provider',
  description:
    'Returns all endpoints of a manual provider. Preset providers do not have configurable endpoints.',
  request: {
    params: providerNameParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: endpointsResponseSchema },
      },
      description: 'List of endpoints',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider is a preset and has no configurable endpoints',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getEndpoints(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof getEndpointsRoute> {
  return (c) => {
    const { name } = c.req.valid('param');
    const provider = deps.config.get().providers[name];

    if (!provider) {
      return c.json({ error: `Provider '${name}' not found` }, 404);
    }

    if ('preset' in provider) {
      return c.json(
        {
          error: `Provider '${name}' is a preset provider and has no configurable endpoints`,
        },
        400,
      );
    }

    const endpoints = Object.entries(provider.endpoints).map(
      ([endpointName, endpoint]) => ({
        name: endpointName,
        url: endpoint.url,
        format: endpoint.format,
        auth: redactAuth(endpoint.auth),
      }),
    );
    return c.json({ endpoints }, 200);
  };
}

// --- POST /v1/providers/{name}/endpoints ---

export const createEndpointRoute = createRoute({
  method: 'post',
  path: '/v1/providers/{name}/endpoints',
  tags: ['Providers'],
  summary: 'Create a new endpoint',
  description:
    'Adds a new endpoint to a manual provider. The endpoint name must be unique within the provider. Endpoint creation is not allowed on preset providers.',
  request: {
    params: providerNameParamSchema,
    body: {
      content: {
        'application/json': { schema: createEndpointBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': { schema: endpointsResponseSchema },
      },
      description: 'Endpoint created — returns updated endpoint list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider is a preset or invalid request body',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider not found',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'An endpoint with this name already exists',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function createEndpoint(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof createEndpointRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');
    const { name: endpointName, ...endpointConfig } = c.req.valid('json');
    const endpoint = endpointConfig as EndpointConfig;

    try {
      await deps.config.addEndpoint(name, endpointName, endpoint);
      return c.json({ endpoints: getEndpointList(deps, name) }, 201);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        if (error.code === 'already_exists')
          return c.json({ error: error.message }, 409);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Endpoint create failed');
      return c.json({ error: 'Failed to create endpoint' }, 500);
    }
  };
}

// --- PATCH /v1/providers/{name}/endpoints/{endpointName} ---

export const updateEndpointRoute = createRoute({
  method: 'patch',
  path: '/v1/providers/{name}/endpoints/{endpointName}',
  tags: ['Providers'],
  summary: 'Partially update an endpoint',
  description:
    'Partially updates an endpoint on a manual provider. Only provided fields are applied; omitted fields preserve current values.',
  request: {
    params: endpointNameParamSchema,
    body: {
      content: {
        'application/json': { schema: updateEndpointBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: endpointsResponseSchema },
      },
      description: 'Endpoint updated — returns updated endpoint list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider is a preset or invalid request body',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider or endpoint not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function updateEndpoint(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof updateEndpointRoute> {
  return async (c) => {
    const { name, endpointName } = c.req.valid('param');
    const patch = c.req.valid('json');

    try {
      await deps.config.mutate((current) => {
        const provider = current.providers[name];
        if (!provider) {
          throw new ConfigValidationError(`Provider '${name}' not found`, {
            code: 'not_found',
          });
        }
        if ('preset' in provider) {
          throw new ConfigValidationError(
            `Cannot update endpoints on preset provider '${name}'`,
            { code: 'type_mismatch' },
          );
        }
        const ep = provider.endpoints[endpointName];
        if (!ep) {
          throw new ConfigValidationError(
            `Endpoint '${endpointName}' not found in provider '${name}'`,
            { code: 'not_found' },
          );
        }
        const merged = {
          url: patch.url ?? ep.url,
          format: patch.format ?? ep.format,
          auth: patch.auth ? mergeAuth(ep.auth, patch.auth) : ep.auth,
          ...('knownModels' in ep && ep.knownModels
            ? { knownModels: ep.knownModels }
            : {}),
        } as ManualEndpoint;
        return {
          ...current,
          providers: {
            ...current.providers,
            [name]: {
              endpoints: { ...provider.endpoints, [endpointName]: merged },
            },
          },
        };
      });
      return c.json({ endpoints: getEndpointList(deps, name) }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Endpoint update failed');
      return c.json({ error: 'Failed to update endpoint' }, 500);
    }
  };
}

// --- DELETE /v1/providers/{name}/endpoints/{endpointName} ---

export const deleteEndpointRoute = createRoute({
  method: 'delete',
  path: '/v1/providers/{name}/endpoints/{endpointName}',
  tags: ['Providers'],
  summary: 'Delete an endpoint',
  description: 'Removes an endpoint from a manual provider.',
  request: {
    params: endpointNameParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: endpointsResponseSchema },
      },
      description: 'Endpoint removed — returns updated endpoint list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider is a preset or validation error',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider or endpoint not found',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description:
        'Endpoint is referenced by model selection and cannot be deleted',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function deleteEndpoint(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof deleteEndpointRoute> {
  return async (c) => {
    const { name, endpointName } = c.req.valid('param');

    try {
      await deps.config.removeEndpoint(name, endpointName);
      return c.json({ endpoints: getEndpointList(deps, name) }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        if (error.code === 'referential_integrity')
          return c.json({ error: error.message }, 409);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Endpoint delete failed');
      return c.json({ error: 'Failed to delete endpoint' }, 500);
    }
  };
}

// --- GET /v1/providers/{name}/known-models ---

export const getKnownModelsRoute = createRoute({
  method: 'get',
  path: '/v1/providers/{name}/known-models',
  tags: ['Providers'],
  summary: 'List known models of a provider',
  description:
    'Returns all known models of a provider. For preset providers, models are listed directly. For manual providers, models are listed per-endpoint; use the endpointName query param to filter to a single endpoint.',
  request: {
    params: providerNameParamSchema,
    query: knownModelQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: knownModelsResponseSchema },
      },
      description: 'List of known models',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'endpointName provided for a preset provider',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider or endpoint not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getKnownModels(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof getKnownModelsRoute> {
  return (c) => {
    const { name } = c.req.valid('param');
    const query = c.req.valid('query');
    const provider = deps.config.get().providers[name];

    if (!provider) {
      return c.json({ error: `Provider '${name}' not found` }, 404);
    }

    if ('preset' in provider && query.endpointName !== undefined) {
      return c.json(
        {
          error: `Preset provider '${name}' does not support endpoint-scoped known models — omit endpointName`,
        },
        400,
      );
    }

    if (
      query.endpointName &&
      !('preset' in provider) &&
      !provider.endpoints[query.endpointName]
    ) {
      return c.json(
        {
          error: `Endpoint '${query.endpointName}' not found in provider '${name}'`,
        },
        404,
      );
    }

    const models = collectKnownModels(name, provider, query.endpointName);
    return c.json({ models }, 200);
  };
}

// --- POST /v1/providers/{name}/known-models ---

export const createKnownModelRoute = createRoute({
  method: 'post',
  path: '/v1/providers/{name}/known-models',
  tags: ['Providers'],
  summary: 'Add a known model',
  description:
    'Adds a new known model to a provider. For preset providers, omit endpointName. For manual providers, endpointName is required and the model is scoped to that endpoint. The modelId must be unique within its scope.',
  request: {
    params: providerNameParamSchema,
    body: {
      content: {
        'application/json': { schema: createKnownModelBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': { schema: knownModelsResponseSchema },
      },
      description: 'Known model created — returns updated model list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description:
        'Invalid request body or endpointName mismatch for provider type',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider or endpoint not found',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'A model with this modelId already exists in this scope',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function createKnownModel(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof createKnownModelRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');
    const body = c.req.valid('json');

    const definition: ModelDefinition = {
      ...(body.displayName !== undefined && { displayName: body.displayName }),
      ...(body.contextSize !== undefined && {
        contextSize: body.contextSize,
      }),
      ...(body.inputCapabilities !== undefined && {
        inputCapabilities: body.inputCapabilities,
      }),
    };

    try {
      await deps.config.addKnownModel(
        name,
        body.modelId,
        definition,
        body.endpointName,
      );
      const models = collectKnownModels(
        name,
        deps.config.get().providers[name]!,
        body.endpointName,
      );
      return c.json({ models }, 201);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        if (error.code === 'already_exists')
          return c.json({ error: error.message }, 409);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Known model create failed');
      return c.json({ error: 'Failed to create known model' }, 500);
    }
  };
}

// --- PATCH /v1/providers/{name}/known-models/{modelId} ---

export const updateKnownModelRoute = createRoute({
  method: 'patch',
  path: '/v1/providers/{name}/known-models/{modelId}',
  tags: ['Providers'],
  summary: 'Partially update a known model',
  description:
    'Partially updates the definition of a known model. For manual providers, provide endpointName as a query param to identify which endpoint the model belongs to.',
  request: {
    params: knownModelIdParamSchema,
    query: knownModelQuerySchema,
    body: {
      content: {
        'application/json': { schema: updateKnownModelBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: knownModelsResponseSchema },
      },
      description: 'Known model updated — returns updated model list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description:
        'Invalid request body or endpointName mismatch for provider type',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider, endpoint, or model not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function updateKnownModel(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof updateKnownModelRoute> {
  return async (c) => {
    const { name, modelId } = c.req.valid('param');
    const query = c.req.valid('query');
    const patch = c.req.valid('json');

    try {
      await deps.config.mutate((current) => {
        const provider = current.providers[name];
        if (!provider) {
          throw new ConfigValidationError(`Provider '${name}' not found`, {
            code: 'not_found',
          });
        }

        const isPreset = 'preset' in provider;
        if (isPreset && query.endpointName !== undefined) {
          throw new ConfigValidationError(
            `Preset provider '${name}' does not support endpoint-scoped known models`,
            { code: 'type_mismatch' },
          );
        }
        if (!isPreset && !query.endpointName) {
          throw new ConfigValidationError(
            `Manual provider '${name}' requires an endpoint name for known models`,
            { code: 'type_mismatch' },
          );
        }

        const currentDef = lookupKnownModel(
          provider,
          modelId,
          query.endpointName,
        );
        if (!currentDef) {
          if (!isPreset && query.endpointName) {
            const endpoint = provider.endpoints[query.endpointName];
            if (!endpoint) {
              throw new ConfigValidationError(
                `Endpoint '${query.endpointName}' not found in provider '${name}'`,
                { code: 'not_found' },
              );
            }
          }
          throw new ConfigValidationError(
            `Model '${modelId}' not found in ${isPreset ? `provider '${name}'` : `endpoint '${query.endpointName}' of provider '${name}'`}`,
            { code: 'not_found' },
          );
        }

        const cleanDef: ModelDefinition = { ...currentDef };
        if (patch.displayName !== undefined)
          cleanDef.displayName = patch.displayName;
        if (patch.contextSize !== undefined)
          cleanDef.contextSize = patch.contextSize;
        if (patch.inputCapabilities !== undefined)
          cleanDef.inputCapabilities = patch.inputCapabilities;

        if (isPreset) {
          const existing = provider.knownModels ?? {};
          return {
            ...current,
            providers: {
              ...current.providers,
              [name]: {
                ...provider,
                knownModels: { ...existing, [modelId]: cleanDef },
              },
            },
          };
        }

        const endpoint = provider.endpoints[query.endpointName!]!;
        const existing = endpoint.knownModels ?? {};
        return {
          ...current,
          providers: {
            ...current.providers,
            [name]: {
              endpoints: {
                ...provider.endpoints,
                [query.endpointName!]: {
                  ...endpoint,
                  knownModels: { ...existing, [modelId]: cleanDef },
                },
              },
            },
          },
        };
      });
      const models = collectKnownModels(
        name,
        deps.config.get().providers[name]!,
        query.endpointName,
      );
      return c.json({ models }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Known model update failed');
      return c.json({ error: 'Failed to update known model' }, 500);
    }
  };
}

// --- DELETE /v1/providers/{name}/known-models/{modelId} ---

export const deleteKnownModelRoute = createRoute({
  method: 'delete',
  path: '/v1/providers/{name}/known-models/{modelId}',
  tags: ['Providers'],
  summary: 'Delete a known model',
  description:
    'Removes a known model from a provider. For manual providers, provide endpointName as a query param to identify which endpoint the model belongs to.',
  request: {
    params: knownModelIdParamSchema,
    query: knownModelQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: knownModelsResponseSchema },
      },
      description: 'Known model removed — returns updated model list',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'endpointName mismatch for provider type',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Provider, endpoint, or model not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function deleteKnownModel(
  deps: ProviderRouteDependencies,
): RouteHandler<typeof deleteKnownModelRoute> {
  return async (c) => {
    const { name, modelId } = c.req.valid('param');
    const query = c.req.valid('query');

    try {
      await deps.config.removeKnownModel(name, modelId, query.endpointName);
      const models = collectKnownModels(
        name,
        deps.config.get().providers[name]!,
        query.endpointName,
      );
      return c.json({ models }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        if (error.code === 'not_found')
          return c.json({ error: error.message }, 404);
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Known model delete failed');
      return c.json({ error: 'Failed to delete known model' }, 500);
    }
  };
}

// --- helpers ---

function redactAuth(auth: EndpointAuth): EndpointAuth {
  return {
    apiKey: auth.apiKey !== undefined ? '[REDACTED]' : undefined,
    headers: auth.headers
      ? Object.fromEntries(
          Object.keys(auth.headers).map((key) => [key, '[REDACTED]']),
        )
      : undefined,
  };
}

function getProviderList(deps: ProviderRouteDependencies) {
  const providers = deps.config.get().providers;
  return Object.entries(providers).map(([name, provider]) => {
    if ('preset' in provider) {
      return {
        name,
        preset: provider.preset,
        auth: redactAuth(provider.auth),
      };
    }
    return {
      name,
      endpoints: Object.fromEntries(
        Object.entries(provider.endpoints).map(([epName, ep]) => [
          epName,
          { url: ep.url, format: ep.format, auth: redactAuth(ep.auth) },
        ]),
      ),
    };
  });
}

function getEndpointList(
  deps: ProviderRouteDependencies,
  providerName: string,
) {
  const provider = deps.config.get().providers[providerName];
  if (!provider || 'preset' in provider) {
    return [];
  }
  return Object.entries(provider.endpoints).map(([endpointName, endpoint]) => ({
    name: endpointName,
    url: endpoint.url,
    format: endpoint.format,
    auth: redactAuth(endpoint.auth),
  }));
}

function mergeProviderPatch(
  current: ProviderConfig,
  patch: {
    preset?: 'openai' | 'anthropic' | 'google';
    auth?: EndpointAuth;
    endpoints?: Record<string, EndpointConfig>;
  },
): ProviderConfig {
  if ('preset' in current) {
    if (patch.endpoints !== undefined) {
      throw new ConfigValidationError(
        `Cannot add endpoints to preset provider — preset providers do not support manual endpoints`,
        { code: 'type_mismatch' },
      );
    }
    return {
      preset: patch.preset ?? current.preset,
      auth: patch.auth ? mergeAuth(current.auth, patch.auth) : current.auth,
      ...(current.knownModels && { knownModels: current.knownModels }),
    };
  }
  if (patch.preset !== undefined || patch.auth !== undefined) {
    throw new ConfigValidationError(
      `Cannot set preset or auth on manual provider — manual providers use endpoints instead`,
      { code: 'type_mismatch' },
    );
  }
  const mergedEndpoints = patch.endpoints
    ? Object.fromEntries(
        Object.entries({ ...current.endpoints, ...patch.endpoints }).map(
          ([epName, ep]) => {
            const existing = current.endpoints[epName];
            if (existing && existing.knownModels && !('knownModels' in ep)) {
              return [epName, { ...ep, knownModels: existing.knownModels }];
            }
            return [epName, ep];
          },
        ),
      )
    : current.endpoints;
  return {
    endpoints: mergedEndpoints,
  };
}

function mergeAuth(current: EndpointAuth, patch: EndpointAuth): EndpointAuth {
  return {
    apiKey: patch.apiKey !== undefined ? patch.apiKey : current.apiKey,
    headers: patch.headers
      ? { ...current.headers, ...patch.headers }
      : current.headers,
  };
}

/**
 * Collects known models from a provider for API responses. For preset
 * providers, models come from `provider.knownModels`. For manual providers,
 * models come from each endpoint's `knownModels`; when `endpointName` is
 * provided, only that endpoint's models are returned.
 */
function collectKnownModels(
  providerName: string,
  provider: ProviderConfig,
  endpointName?: string,
): Array<{
  modelId: string;
  endpointName?: string;
  displayName?: string;
  contextSize?: number;
  inputCapabilities?: ModelInputCapabilities;
}> {
  if ('preset' in provider) {
    const models = provider.knownModels ?? {};
    return Object.entries(models).map(([modelId, def]) => ({
      modelId,
      displayName: def.displayName,
      contextSize: def.contextSize,
      inputCapabilities: def.inputCapabilities,
    }));
  }

  const endpoints = endpointName
    ? { [endpointName]: provider.endpoints[endpointName] }
    : provider.endpoints;

  const result: Array<{
    modelId: string;
    endpointName?: string;
    displayName?: string;
    contextSize?: number;
    inputCapabilities?: ModelInputCapabilities;
  }> = [];
  for (const [epName, endpoint] of Object.entries(endpoints)) {
    if (!endpoint) continue;
    const models = endpoint.knownModels ?? {};
    for (const [modelId, def] of Object.entries(models)) {
      result.push({
        modelId,
        endpointName: epName,
        displayName: def.displayName,
        contextSize: def.contextSize,
        inputCapabilities: def.inputCapabilities,
      });
    }
  }
  return result;
}

/**
 * Looks up a single known model definition from a provider. For preset
 * providers, searches `provider.knownModels`. For manual providers, searches
 * the specified endpoint's `knownModels`. Returns `undefined` if not found.
 */
function lookupKnownModel(
  provider: ProviderConfig,
  modelId: string,
  endpointName?: string,
): ModelDefinition | undefined {
  if ('preset' in provider) {
    return provider.knownModels?.[modelId];
  }
  if (!endpointName) return undefined;
  return provider.endpoints[endpointName]?.knownModels?.[modelId];
}
