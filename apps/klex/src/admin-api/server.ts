import { type Hook, OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import type { ModuleLogger } from '@stagewise/logger';

import type { CloudConnectivity } from '@/cloud-connectivity';
import type { Config } from '@/config';
import type { Introspector } from '@/introspection';
import type { Mcp } from '@/mcp';
import type { ModelCallLogger } from '@/model-call-logger';

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
  getMcpServers,
  getMcpServersRoute,
  getMcpToolCallHistory,
  getMcpToolCallHistoryRoute,
  updateMcpServer,
  updateMcpServerRoute,
} from './routes/v1/mcp';
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
  getModelSelection,
  getModelSelectionRoute,
  getTelemetry,
  getTelemetryRoute,
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
  port: number;
}

// biome-ignore lint/suspicious/noExplicitAny: Hook generic parameters are opaque validation types
const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map((i) =>
        i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
      )
      .join('; ');
    return c.json({ error: message }, 400);
  }
};

export function createAdminApp(deps: AdminAppDependencies) {
  const app = new OpenAPIHono({
    defaultHook: validationHook,
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: 'Malformed JSON in request body' }, 400);
    }
    deps.logger.error({ error: err }, 'Unhandled error in admin API');
    return c.json({ error: 'Internal server error' }, 500);
  });

  const routedApp = app
    .openapi(healthRoute, getHealth())
    .openapi(getCloudStatusRoute, getCloudStatus(deps))
    .openapi(enrollCloudRoute, enrollCloud(deps))
    .openapi(getModelSelectionRoute, getModelSelection(deps))
    .openapi(patchModelSelectionRoute, patchModelSelection(deps))
    .openapi(getTelemetryRoute, getTelemetry(deps))
    .openapi(patchTelemetryRoute, patchTelemetry(deps))
    .openapi(
      introspectionRootRoute,
      getIntrospectionRoot({ introspector: deps.introspector }),
    )
    .openapi(getMcpServersRoute, getMcpServers(deps))
    .openapi(createMcpServerRoute, createMcpServer(deps))
    .openapi(updateMcpServerRoute, updateMcpServer(deps))
    .openapi(deleteMcpServerRoute, deleteMcpServer(deps))
    .openapi(getMcpToolCallHistoryRoute, getMcpToolCallHistory(deps))
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
    // Must match the loopback-only bind in admin-api.ts.
    servers: [{ url: `http://127.0.0.1:${deps.port}` }],
  });

  const appWithIntrospection = routedApp.get(
    '/v1/introspect/:path{.+}',
    getIntrospectionPathHandler({ introspector: deps.introspector }),
  );

  return appWithIntrospection;
}

export type AdminApp = ReturnType<typeof createAdminApp>;
