import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { AdmissionGate } from '@/admission';
import { createIntrospector } from '@/introspection';

import { type AdminAppDependencies, createAdminApp } from './server';

function setup(admission: AdmissionGate) {
  const sendGodMessage = vi.fn(async () => ({ sessionId: 'god' }));
  const app = createAdminApp({
    admission,
    godMessages: { sendGodMessage },
    logger: { debug: vi.fn(), error: vi.fn() },
    introspector: createIntrospector({
      logging: createLogger({ name: 'test', type: 'hidden' }),
    }),
    providerRegistry: { listProviderTypes: () => [], listInstances: () => [] },
  } as unknown as AdminAppDependencies);
  return { app, sendGodMessage };
}

describe('admin admission', () => {
  it('rejects new reads and mutations retryably while retaining liveness access', async () => {
    const admission = new AdmissionGate();
    const { app, sendGodMessage } = setup(admission);
    const result = await admission.prepare();
    if (result.outcome !== 'quiescent') throw new Error('Expected quiescence');
    for (const [method, path] of [
      ['GET', '/v1/providers'],
      ['POST', '/v1/god-messages'],
      ['PATCH', '/v1/settings/models'],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('1');
      expect(await response.json()).toMatchObject({ retryable: true });
    }
    expect(sendGodMessage).not.toHaveBeenCalled();
    expect((await app.request('/v1/health')).status).toBe(200);
    expect((await app.request('/v1/introspect')).status).toBe(200);
    expect(admission.abort('cancelled', result.lease)).toBe(true);
    expect((await app.request('/v1/providers')).status).toBe(200);
    admission.close();
  });

  it('drains a request admitted before cutoff without tearing it down on timeout', async () => {
    const admission = new AdmissionGate({ graceMs: 20 });
    const { app, sendGodMessage } = setup(admission);
    let complete!: () => void;
    sendGodMessage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return { sessionId: 'god' };
    });
    const request = app.request('/v1/god-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'admitted' }] }),
    });
    await vi.waitFor(() => expect(sendGodMessage).toHaveBeenCalledOnce());
    expect((await admission.prepare()).outcome).toBe('aborted');
    expect(admission.status()).toMatchObject({ state: 'open', activeWork: 1 });
    complete();
    expect((await request).status).toBe(202);
    expect(admission.status().activeWork).toBe(0);
    admission.close();
  });
});
