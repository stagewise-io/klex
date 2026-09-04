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
  describe('dangerous local port enabled', () => {
    let api: AdminApi;

    it('starts and binds to the configured port', async () => {
      api = createAdminApi({
        logging: logger,
        config,
        mcp,
        introspector,
        modelCallLogger,
        cloudConnectivity,
        localPort: 19999,
      });

      await api.start();

      // Verify the port is listening by making a request. The server binds
      // loopback only, so the client must dial 127.0.0.1 explicitly.
      const response = await fetch('http://127.0.0.1:19999/v1/health');
      expect(response.status).toBe(200);
    });

    it('closes the server', async () => {
      await api.close();

      await expect(fetch('http://127.0.0.1:19999/v1/health')).rejects.toThrow();
    });
  });

  describe('private mode', () => {
    let api: AdminApi;

    it('starts without binding a local port', async () => {
      api = createAdminApi({
        logging: logger,
        config,
        mcp,
        introspector,
        modelCallLogger,
        cloudConnectivity,
        localPort: undefined,
      });

      await api.start();

      await expect(fetch('http://127.0.0.1:19998/v1/health')).rejects.toThrow();

      const response = await api.handle(
        new Request('http://klex.local/v1/health'),
      );
      expect(response.status).toBe(200);
    });

    it.each([
      ['unknown path', new Request('http://klex.local/v1/unknown')],
      [
        'unsupported method',
        new Request('http://klex.local/v1/health', { method: 'POST' }),
      ],
    ])('formats %s errors as JSON', async (_case, request) => {
      const response = await api.handle(request);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Not found',
        code: 'not_found',
      });
    });

    it('close() is safe without a local listener', async () => {
      await api.close();
    });
  });
});
