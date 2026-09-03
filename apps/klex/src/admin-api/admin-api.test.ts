import { describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { CloudConnectivity } from '@/cloud-connectivity';
import type { Config } from '@/config';
import type { Introspector } from '@/introspection';
import type { Mcp } from '@/mcp';
import type { ModelCallLogger } from '@/model-call-logger';

import { type AdminApi, createAdminApi } from './admin-api';

const logger = {
  child: () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

const config = {} as Config;
const mcp = {} as Mcp;
const introspector = {} as Introspector;
const modelCallLogger = {} as ModelCallLogger;
const cloudConnectivity = {
  start: async () => undefined,
  close: async () => undefined,
  getAccessToken: async () => 'token',
  invalidateAccessToken: () => undefined,
  getApiClient: () => ({}),
  isEnrolled: () => true,
  isCloudEnabled: () => true,
  isTrustedAuthorizationServer: () => true,
  getEnrollmentState: () => ({
    clientId: 'client-1',
    enrolledAt: '2025-01-01T00:00:00Z',
    kid: 'kid-1',
  }),
  getCloudBaseUrl: () => 'https://cloud.example',
  enroll: async () => ({
    clientId: 'client-1',
    enrolledAt: '2025-01-01T00:00:00Z',
  }),
  getTunnelState: () => 'disconnected',
} as unknown as CloudConnectivity;

describe('AdminApi', () => {
  describe('cloud disabled — binds local port', () => {
    let api: AdminApi;

    it('starts and binds to the configured port', async () => {
      api = createAdminApi({
        logging: logger,
        config,
        mcp,
        introspector,
        modelCallLogger,
        cloudConnectivity,
        cloudEnabled: false,
        port: 19999,
      });

      await api.start();

      // Verify the port is listening by making a request
      const response = await fetch('http://0.0.0.0:19999/v1/health');
      expect(response.status).toBe(200);
    });

    it('closes the server', async () => {
      await api.close();

      await expect(fetch('http://0.0.0.0:19999/v1/health')).rejects.toThrow();
    });
  });

  describe('cloud enabled — tunnel-only mode', () => {
    let api: AdminApi;

    it('starts without binding a local port', async () => {
      api = createAdminApi({
        logging: logger,
        config,
        mcp,
        introspector,
        modelCallLogger,
        cloudConnectivity,
        cloudEnabled: true,
        port: 19998,
      });

      await api.start();

      // Port should NOT be bound
      await expect(fetch('http://0.0.0.0:19998/v1/health')).rejects.toThrow();
    });

    it('close() is safe when tunnel-only', async () => {
      await api.close();
    });
  });
});
