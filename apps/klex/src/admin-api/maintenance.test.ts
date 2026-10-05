import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { AdmissionGate } from '@/admission';
import { createIntrospector } from '@/introspection';

import { type AdminApiDependencies, createAdminApi } from './admin-api';
import { createTrustedTunnelHandler } from './maintenance';

const gates: AdmissionGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.close();
});

async function setup(graceMs = 60_000) {
  const admission = new AdmissionGate({ graceMs });
  gates.push(admission);
  const logging = createLogger({ name: 'test', type: 'hidden' });
  const api = createAdminApi({
    admission,
    logging,
    introspector: createIntrospector({ logging }),
    localPort: undefined,
    timezone: 'UTC',
  } as AdminApiDependencies);
  await api.start();
  const logger = { info: vi.fn() };
  const tunnel = createTrustedTunnelHandler({
    admission,
    logger,
    handle: api.handle.bind(api),
  });
  const request = (path: string, method = 'GET', body?: object) =>
    new Request(`http://untrusted-host${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer forged',
        'X-Klex-Cloud': 'true',
        'X-Forwarded-Host': 'cloud.klex.ai',
        Origin: 'https://cloud.klex.ai',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { admission, api, tunnel, request, logger };
}

describe('trusted Cloud maintenance dispatch', () => {
  it('denies maintenance on ordinary handle even with forged headers, including during drain', async () => {
    const { admission, api, tunnel, request } = await setup();
    const work = admission.admitRoot();
    for (const phase of ['open', 'draining']) {
      for (const [path, method] of [
        ['prepare', 'POST'],
        ['status', 'GET'],
        ['abort', 'POST'],
      ] as const) {
        const response = await api.handle(
          request(`/v1/maintenance/${path}`, method),
        );
        expect(response.status).toBe(404);
      }
      expect(
        (await api.handle(request('/v1/introspect/admission'))).status,
      ).toBe(404);
      expect(
        JSON.stringify(
          await (await api.handle(request('/v1/introspect'))).json(),
        ),
      ).not.toContain('admission');
      if (phase === 'open')
        expect(
          (await tunnel(request('/v1/maintenance/prepare', 'POST'))).status,
        ).toBe(202);
    }
    admission.abort('test complete');
    work.release();
    await api.close();
  });

  it('returns promptly, polls and aborts during drain, and fences stale IDs from newer preparations', async () => {
    const { admission, tunnel, request, logger } = await setup();
    const work = admission.admitRoot();
    const response = await tunnel(request('/v1/maintenance/prepare', 'POST'));
    expect(response.status).toBe(202);
    const first = (await response.json()) as { operationId: string };
    expect(first).toEqual({ operationId: expect.any(String) });
    expect(
      (await tunnel(request('/v1/maintenance/prepare', 'POST'))).status,
    ).toBe(409);
    const status = (await (
      await tunnel(request('/v1/maintenance/status'))
    ).json()) as { admission: { epoch: number } };
    expect(status).toMatchObject({
      operationId: first.operationId,
      admission: { state: 'draining', activeWork: 1 },
    });
    expect(JSON.stringify(status)).not.toContain('lease');
    expect(
      (
        await tunnel(
          request('/v1/maintenance/abort', 'POST', {
            epoch: status.admission.epoch,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      await (
        await tunnel(request('/v1/maintenance/abort', 'POST', first))
      ).json(),
    ).toEqual({ aborted: true });
    const second = (await (
      await tunnel(request('/v1/maintenance/prepare', 'POST'))
    ).json()) as { operationId: string };
    expect(second.operationId).not.toBe(first.operationId);
    expect(
      (await tunnel(request('/v1/maintenance/abort', 'POST', first))).status,
    ).toBe(409);
    expect(
      (
        await tunnel(
          request(`/v1/maintenance/status?operationId=${first.operationId}`),
        )
      ).status,
    ).toBe(409);
    expect(admission.status().state).toBe('draining');
    work.release();
    await vi.waitFor(() => expect(admission.status().state).toBe('quiescent'));
    expect(
      (await tunnel(request('/v1/maintenance/abort', 'POST', second))).status,
    ).toBe(200);
    expect(admission.status().state).toBe('open');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('forged');
  });

  it('reports timeout and rejects abort for an expired operation', async () => {
    const { admission, tunnel, request } = await setup(20);
    const work = admission.admitRoot();
    const operation = (await (
      await tunnel(request('/v1/maintenance/prepare', 'POST'))
    ).json()) as { operationId: string };
    await vi.waitFor(() => expect(admission.status().state).toBe('open'));
    expect(
      await (await tunnel(request('/v1/maintenance/status'))).json(),
    ).toMatchObject({
      outcome: 'aborted',
      admission: { reason: 'Drain grace expired' },
    });
    expect(
      (await tunnel(request('/v1/maintenance/abort', 'POST', operation)))
        .status,
    ).toBe(409);
    work.release();
  });
});
