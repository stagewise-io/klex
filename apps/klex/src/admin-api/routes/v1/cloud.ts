import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { CloudConnectivity } from '@/cloud-connectivity';

import {
  cloudEnrollBodySchema,
  cloudEnrollResponseSchema,
  cloudStatusResponseSchema,
  errorResponseSchema,
} from './schemas';

export interface CloudRouteDependencies {
  cloudConnectivity: CloudConnectivity;
  logger: ModuleLogger;
}

// --- GET /v1/cloud/status ---

export const getCloudStatusRoute = createRoute({
  method: 'get',
  path: '/v1/cloud/status',
  tags: ['Cloud'],
  summary: 'Get cloud enrollment status',
  description:
    'Returns the current cloud connectivity and enrollment status, including the cloud base URL and enrollment ID when enrolled.',
  responses: {
    200: {
      content: {
        'application/json': { schema: cloudStatusResponseSchema },
      },
      description: 'Cloud status',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getCloudStatus(
  deps: CloudRouteDependencies,
): RouteHandler<typeof getCloudStatusRoute> {
  return (c) => {
    const state = deps.cloudConnectivity.getEnrollmentState();
    return c.json(
      {
        cloudEnabled: deps.cloudConnectivity.isCloudEnabled(),
        enrolled: deps.cloudConnectivity.isEnrolled(),
        clientId: state.clientId,
        enrolledAt: state.enrolledAt,
        cloudBaseUrl: deps.cloudConnectivity.getCloudBaseUrl(),
        tunnelState: deps.cloudConnectivity.getTunnelState(),
      },
      200,
    );
  };
}

// --- POST /v1/cloud/enroll ---

export const enrollCloudRoute = createRoute({
  method: 'post',
  path: '/v1/cloud/enroll',
  tags: ['Cloud'],
  summary: 'Enroll agent in Klex Cloud',
  description:
    'Enrolls the agent using an enrollment code obtained from the Klex Cloud UI. The code is exchanged for a client ID and persisted locally.',
  request: {
    body: {
      content: {
        'application/json': { schema: cloudEnrollBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: cloudEnrollResponseSchema },
      },
      description: 'Enrollment successful',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Enrollment failed (invalid code or cloud disabled)',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function enrollCloud(
  deps: CloudRouteDependencies,
): RouteHandler<typeof enrollCloudRoute> {
  return async (c) => {
    const { enrollmentCode } = c.req.valid('json');

    try {
      const result = await deps.cloudConnectivity.enroll(enrollmentCode);
      return c.json(result, 200);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Enrollment failed';
      deps.logger.error({ error }, 'Cloud enrollment failed');
      return c.json({ error: message }, 400);
    }
  };
}
