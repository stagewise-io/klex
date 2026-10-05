import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import type { ModuleLogger } from '@stagewise/logger';

import {
  type AdmissionGate,
  AdmissionRejectedError,
  type MaintenanceLease,
} from '@/admission';

/** Install only at CloudConnectivity.setTunnelRequestHandler. Request data is
 * never an authorization signal: Cloud authorizes before forwarding here. */
export function createTrustedTunnelHandler(deps: {
  admission: AdmissionGate;
  logger: Pick<ModuleLogger, 'info'>;
  handle(request: Request): Response | Promise<Response>;
}) {
  const app = new Hono();
  let operation:
    | {
        id: string;
        epoch: number;
        outcome: 'draining' | 'quiescent' | 'aborted';
        lease?: MaintenanceLease;
      }
    | undefined;

  const isCurrent = () => {
    const status = deps.admission.status();
    return (
      operation &&
      operation.epoch === status.epoch &&
      (status.state === 'draining' || status.state === 'quiescent')
    );
  };

  app.post('/v1/maintenance/prepare', (c) => {
    if (isCurrent())
      return c.json({ error: 'Preparation already active' }, 409);
    let preparing: ReturnType<AdmissionGate['prepare']>;
    try {
      preparing = deps.admission.prepare();
    } catch (error) {
      if (!(error instanceof AdmissionRejectedError)) throw error;
      return c.json({ error: 'Preparation unavailable' }, 409);
    }
    const current = {
      id: randomUUID(),
      epoch: deps.admission.status().epoch,
      outcome: 'draining' as 'draining' | 'quiescent' | 'aborted',
      lease: undefined as MaintenanceLease | undefined,
    };
    operation = current;
    deps.logger.info(
      { operationId: current.id, action: 'prepare' },
      'Maintenance operator action',
    );
    void preparing.then((result) => {
      current.outcome = result.outcome;
      if (result.outcome === 'quiescent') current.lease = result.lease;
      deps.logger.info(
        { operationId: current.id, outcome: result.outcome },
        'Maintenance preparation outcome',
      );
    });
    return c.json({ operationId: current.id }, 202);
  });

  app.get('/v1/maintenance/status', (c) => {
    const id = c.req.query('operationId');
    if (id !== undefined && id !== operation?.id)
      return c.json({ error: 'Stale operation' }, 409);
    return c.json({
      operationId: operation?.id ?? null,
      outcome: operation ? (isCurrent() ? operation.outcome : 'aborted') : null,
      admission: deps.admission.status(),
    });
  });

  app.post('/v1/maintenance/abort', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const id =
      body && typeof body === 'object' && 'operationId' in body
        ? body.operationId
        : undefined;
    if (typeof id !== 'string' || id !== operation?.id || !isCurrent())
      return c.json({ error: 'Stale operation' }, 409);
    // Identity and epoch are checked synchronously above. During drain the
    // real lease has not been returned yet; no caller-supplied lease is read.
    const aborted = deps.admission.abort(
      'Operator cancelled maintenance',
      operation.lease,
    );
    operation.lease = undefined;
    operation.outcome = 'aborted';
    deps.logger.info(
      { operationId: id, action: 'abort', aborted },
      'Maintenance operator action',
    );
    return c.json({ aborted });
  });
  app.all('/v1/maintenance/*', (c) => c.notFound());
  app.all('*', (c) => deps.handle(c.req.raw));
  return (request: Request) => app.fetch(request);
}
