import { OpenAPIHono } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { CloudConnectivity } from '@/cloud-connectivity';
import type { Config } from '@/config';
import type { Introspector } from '@/introspection';
import type { Mcp } from '@/mcp';
import type { ModelCallLogger } from '@/model-call-logger';

import { createErrorHandler, notFoundHandler, validationHook } from './errors';
import {
  enrollCloud,
  enrollCloudRoute,
  getCloudStatus,
  getCloudStatusRoute,
} from './routes/v1/cloud';
import { getHealth, healthRoute } from './routes/v1/health';
import {
  getIntrospectionPathHandler,
  getIntrospectionRoot,
  introspectionRootRoute,
  registerIntrospectionPathRoute,
} from './routes/v1/introspection';
import {
  createMcpServer,
  createMcpServerRoute,
  deleteMcpServer,
  deleteMcpServerRoute,
  getMcpServer,
  getMcpServerRoute,
  getMcpServers,
  getMcpServersRoute,
  getMcpToolCallHistory,
  getMcpToolCallHistoryRoute,
  updateMcpServer,
  updateMcpServerRoute,
} from './routes/v1/mcp';
import {
  cancelAuthorization,
  cancelAuthorizationRoute,
  completeAuthorization,
  completeAuthorizationRoute,
  startAuthorization,
  startAuthorizationRoute,
} from './routes/v1/mcp.authorization';
import {
  createEndpoint,
  createEndpointRoute,
  createKnownModel,
  createKnownModelRoute,
  createProvider,
  createProviderRoute,
  deleteEndpoint,
  deleteEndpointRoute,
  deleteKnownModel,
  deleteKnownModelRoute,
  deleteProvider,
  deleteProviderRoute,
  getEndpoints,
  getEndpointsRoute,
  getKnownModels,
  getKnownModelsRoute,
  getProviders,
  getProvidersRoute,
  updateEndpoint,
  updateEndpointRoute,
  updateKnownModel,
  updateKnownModelRoute,
  updateProvider,
  updateProviderRoute,
} from './routes/v1/providers';
import {
  getAgentIdentity,
  getAgentIdentityRoute,
  getModelSelection,
  getModelSelectionRoute,
  getTelemetry,
  getTelemetryRoute,
  patchAgentIdentity,
  patchAgentIdentityRoute,
  patchModelSelection,
  patchModelSelectionRoute,
  patchTelemetry,
  patchTelemetryRoute,
} from './routes/v1/settings';
import { getUsage, getUsageRoute } from './routes/v1/usage';

export interface AdminAppDependencies {
  config: Config;
  mcp: Mcp;
  introspector: Introspector;
  modelCallLogger: ModelCallLogger;
  cloudConnectivity: CloudConnectivity;
  logger: ModuleLogger;
  localPort: number | undefined;
}

export function createAdminApp(deps: AdminAppDependencies) {
  const app = new OpenAPIHono({
    defaultHook: validationHook,
  });

  app.use('*', async (c, next) => {
    deps.logger.debug(
      { method: c.req.method, path: c.req.path },
      'Admin API request',
    );
    await next();
  });

  app.onError(
    createErrorHandler((error) => {
      deps.logger.error({ error }, 'Unhandled error in admin API');
    }),
  );
  app.notFound(notFoundHandler);

  const routedApp = app
    .openapi(healthRoute, getHealth())
    .openapi(getCloudStatusRoute, getCloudStatus(deps))
    .openapi(enrollCloudRoute, enrollCloud(deps))
    .openapi(getAgentIdentityRoute, getAgentIdentity(deps))
    .openapi(patchAgentIdentityRoute, patchAgentIdentity(deps))
    .openapi(getModelSelectionRoute, getModelSelection(deps))
    .openapi(patchModelSelectionRoute, patchModelSelection(deps))
    .openapi(getTelemetryRoute, getTelemetry(deps))
    .openapi(patchTelemetryRoute, patchTelemetry(deps))
    .openapi(
      introspectionRootRoute,
      getIntrospectionRoot({ introspector: deps.introspector }),
    )
    .openapi(getMcpServersRoute, getMcpServers(deps))
    .openapi(getMcpServerRoute, getMcpServer(deps))
    .openapi(createMcpServerRoute, createMcpServer(deps))
    .openapi(updateMcpServerRoute, updateMcpServer(deps))
    .openapi(deleteMcpServerRoute, deleteMcpServer(deps))
    .openapi(getMcpToolCallHistoryRoute, getMcpToolCallHistory(deps))
    .openapi(startAuthorizationRoute, startAuthorization(deps))
    .openapi(cancelAuthorizationRoute, cancelAuthorization(deps))
    .openapi(completeAuthorizationRoute, completeAuthorization(deps))
    .openapi(getUsageRoute, getUsage(deps))
    .openapi(getProvidersRoute, getProviders(deps))
    .openapi(createProviderRoute, createProvider(deps))
    .openapi(updateProviderRoute, updateProvider(deps))
    .openapi(deleteProviderRoute, deleteProvider(deps))
    .openapi(getEndpointsRoute, getEndpoints(deps))
    .openapi(createEndpointRoute, createEndpoint(deps))
    .openapi(updateEndpointRoute, updateEndpoint(deps))
    .openapi(deleteEndpointRoute, deleteEndpoint(deps))
    .openapi(getKnownModelsRoute, getKnownModels(deps))
    .openapi(createKnownModelRoute, createKnownModel(deps))
    .openapi(updateKnownModelRoute, updateKnownModel(deps))
    .openapi(deleteKnownModelRoute, deleteKnownModel(deps));

  registerIntrospectionPathRoute(app);

  // OpenAPI spec endpoint
  app.doc('/v1/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Klex Bot Admin API',
      version: '1.0.0',
      description:
        'Observability and management API for the Klex Bot admin plane. Provides session state, token consumption, MCP connection status, tool call history, and configuration management.',
    },
    // Only advertise a local server when the dangerous opt-in is enabled.
    ...(deps.localPort === undefined
      ? {}
      : { servers: [{ url: `http://127.0.0.1:${deps.localPort}` }] }),
  });

  const appWithIntrospection = routedApp.get(
    '/v1/introspect/:path{.+}',
    getIntrospectionPathHandler({ introspector: deps.introspector }),
  );

  return appWithIntrospection;
}

export type AdminApp = ReturnType<typeof createAdminApp>;
