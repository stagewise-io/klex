import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { CloudConnectivity } from '@/cloud-connectivity';

import {
  type CloudRouteDependencies,
  enrollCloud,
  enrollCloudRoute,
  getCloudStatus,
  getCloudStatusRoute,
} from './cloud';
import { setupTestApp } from './test-utils';

const logger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
} as unknown as ModuleLogger;

function createMockCloud(
  overrides: Partial<CloudConnectivity> = {},
): CloudConnectivity {
  return {
    isCloudEnabled: () => true,
    isEnrolled: () => false,
    getEnrollmentState: () => ({
      clientId: null,
      enrolledAt: null,
      kid: 'klex-key-test',
    }),
    getCloudBaseUrl: () => 'https://cloud.klex.bot',
    enroll: vi.fn(),
    getAccessToken: vi.fn(),
    getTunnelState: () => 'disconnected',
    start: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as CloudConnectivity;
}

function createApp(deps: CloudRouteDependencies) {
  return setupTestApp((app) => {
    app.openapi(getCloudStatusRoute, getCloudStatus(deps));
    app.openapi(enrollCloudRoute, enrollCloud(deps));
  });
}

describe('Cloud routes', () => {
  describe('GET /v1/cloud/status', () => {
    it('returns cloud status when not enrolled', async () => {
      const cloud = createMockCloud();
      const app = createApp({ cloudConnectivity: cloud, logger });

      const res = await app.request('/v1/cloud/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        cloudEnabled: true,
        enrolled: false,
        clientId: null,
        enrolledAt: null,
        cloudBaseUrl: 'https://cloud.klex.bot',
        tunnelState: 'disconnected',
      });
    });

    it('returns cloud status when enrolled', async () => {
      const cloud = createMockCloud({
        isEnrolled: () => true,
        getEnrollmentState: () => ({
          clientId: 'client-123',
          enrolledAt: '2025-01-01T00:00:00.000Z',
          kid: 'klex-key-test',
        }),
      });
      const app = createApp({ cloudConnectivity: cloud, logger });

      const res = await app.request('/v1/cloud/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        cloudEnabled: true,
        enrolled: true,
        clientId: 'client-123',
        enrolledAt: '2025-01-01T00:00:00.000Z',
        cloudBaseUrl: 'https://cloud.klex.bot',
        tunnelState: 'disconnected',
      });
    });

    it('reflects cloud disabled state', async () => {
      const cloud = createMockCloud({
        isCloudEnabled: () => false,
      });
      const app = createApp({ cloudConnectivity: cloud, logger });

      const res = await app.request('/v1/cloud/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cloudEnabled: boolean };
      expect(body.cloudEnabled).toBe(false);
    });
  });

  describe('POST /v1/cloud/enroll', () => {
    it('enrolls successfully and returns clientId', async () => {
      const cloud = createMockCloud({
        enroll: vi.fn().mockResolvedValue({
          clientId: 'client-new',
          enrolledAt: '2025-06-01T12:00:00.000Z',
        }),
      });
      const app = createApp({ cloudConnectivity: cloud, logger });

      const res = await app.request('/v1/cloud/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollmentCode: 'VALID-CODE' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        clientId: 'client-new',
        enrolledAt: '2025-06-01T12:00:00.000Z',
      });
      expect(cloud.enroll).toHaveBeenCalledWith('VALID-CODE');
    });

    it('returns 400 on enrollment failure', async () => {
      const cloud = createMockCloud({
        enroll: vi.fn().mockRejectedValue(new Error('Invalid enrollment code')),
      });
      const app = createApp({ cloudConnectivity: cloud, logger });

      const res = await app.request('/v1/cloud/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollmentCode: 'BAD-CODE' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Invalid enrollment code');
    });

    it('returns 400 on empty enrollment code', async () => {
      const cloud = createMockCloud();
      const app = createApp({ cloudConnectivity: cloud, logger });

      const res = await app.request('/v1/cloud/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollmentCode: '' }),
      });
      expect(res.status).toBe(400);
    });
  });
});
