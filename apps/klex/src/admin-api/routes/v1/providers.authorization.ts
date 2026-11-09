import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  ProviderOperationFailure,
  ProviderRegistry,
} from '@/provider-registry';

import {
  errorResponseSchema,
  providerAuthorizationStartedSchema,
  providerIdParamSchema,
} from './schemas';

export interface ProviderAuthorizationRouteDependencies {
  providerRegistry: ProviderRegistry;
  logger: ModuleLogger;
}

const failureBody = (failure: ProviderOperationFailure) => ({
  error: failure.message,
  code: failure.code,
  ...(failure.remediation && { remediation: failure.remediation }),
});

// --- PUT /v1/providers/{id}/authorization ---

export const startProviderAuthorizationRoute = createRoute({
  method: 'put',
  path: '/v1/providers/{id}/authorization',
  tags: ['Providers'],
  summary: 'Start or reuse an interactive provider sign-in',
  description:
    'Starts a device-code sign-in for a provider instance that needs registry-owned credentials, or returns the live one. The user opens "verificationUri" and enters "userCode"; Klex polls for approval in the background and stores the resulting credentials. The verification URI and user code appear in no other response — poll GET /v1/providers for "authorization.status".',
  request: { params: providerIdParamSchema },
  responses: {
    200: {
      content: {
        'application/json': { schema: providerAuthorizationStartedSchema },
      },
      description: 'Sign-in is pending user approval',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description:
        'Provider is already signed in, or does not use interactive sign-in',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal error',
    },
    503: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'The provider sign-in service could not be reached',
    },
  },
});

export function startProviderAuthorization(
  deps: ProviderAuthorizationRouteDependencies,
): RouteHandler<typeof startProviderAuthorizationRoute> {
  return async (c) => {
    const { id } = c.req.valid('param');
    const result = await deps.providerRegistry.startAuthorization(id);

    // Never log the verification URI or user code: together they sign in.
    deps.logger.info(
      { providerId: id, outcome: result.code },
      'Provider sign-in requested',
    );

    if (result.ok) {
      const {
        id: attemptId,
        verificationUri,
        userCode,
        expiresAt,
      } = result.value;
      return c.json(
        { id: attemptId, verificationUri, userCode, expiresAt },
        200,
      );
    }
    if (result.code === 'not_found') return c.json(failureBody(result), 404);
    if (result.code === 'conflict' || result.code === 'unsupported_operation')
      return c.json(failureBody(result), 409);
    if (result.code === 'internal_error')
      return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 503);
  };
}

// --- DELETE /v1/providers/{id}/authorization ---

export const cancelProviderAuthorizationRoute = createRoute({
  method: 'delete',
  path: '/v1/providers/{id}/authorization',
  tags: ['Providers'],
  summary: 'Cancel the pending sign-in of a provider',
  description:
    'Stops polling. Stored credentials are not touched; use DELETE /v1/providers/{id}/credentials to sign out.',
  request: { params: providerIdParamSchema },
  responses: {
    204: { description: 'Sign-in canceled' },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider not found, or no sign-in is pending',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider does not use interactive sign-in',
    },
  },
});

export function cancelProviderAuthorization(
  deps: ProviderAuthorizationRouteDependencies,
): RouteHandler<typeof cancelProviderAuthorizationRoute> {
  return async (c) => {
    const { id } = c.req.valid('param');
    const result = await deps.providerRegistry.cancelAuthorization(id);
    deps.logger.info(
      { providerId: id, outcome: result.code },
      'Provider sign-in cancel requested',
    );
    if (result.ok) return c.body(null, 204);
    if (result.code === 'not_found') return c.json(failureBody(result), 404);
    return c.json(failureBody(result), 409);
  };
}

// --- DELETE /v1/providers/{id}/credentials ---

export const deleteProviderCredentialsRoute = createRoute({
  method: 'delete',
  path: '/v1/providers/{id}/credentials',
  tags: ['Providers'],
  summary: 'Sign a provider out',
  description:
    'Cancels any pending sign-in and deletes the registry-owned credentials of the provider instance. The instance itself stays configured.',
  request: { params: providerIdParamSchema },
  responses: {
    204: { description: 'Signed out' },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Provider does not use interactive sign-in',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal error',
    },
  },
});

export function deleteProviderCredentials(
  deps: ProviderAuthorizationRouteDependencies,
): RouteHandler<typeof deleteProviderCredentialsRoute> {
  return async (c) => {
    const { id } = c.req.valid('param');
    const result = await deps.providerRegistry.signOut(id);
    deps.logger.info(
      { providerId: id, outcome: result.code },
      'Provider sign-out requested',
    );
    if (result.ok) return c.body(null, 204);
    if (result.code === 'not_found') return c.json(failureBody(result), 404);
    if (result.code === 'internal_error')
      return c.json(failureBody(result), 500);
    return c.json(failureBody(result), 409);
  };
}
