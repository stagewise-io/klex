import { createMachineMcp, type MachineMcp } from '../mcp.js';
import type { NotificationStore } from '../notifications/index.js';
import type { MachineAuthenticator } from './auth.js';
import type { MachineLeaseReporter } from './lease-reporter.js';

export interface PrincipalMcpRouter {
  fetch(request: Request): Promise<Response>;
  /** Report every principal's workloads, existing and future, under its client ID. */
  attachLeaseReporter(reporter: MachineLeaseReporter): void;
  close(): Promise<void>;
}

export function createPrincipalMcpRouter(
  authenticator: MachineAuthenticator,
  defaultCwd: string,
  notifications: NotificationStore,
  createMcp: (
    cwd: string,
    principalId: string,
    store: NotificationStore,
  ) => MachineMcp = (cwd, principalId, store) =>
    createMachineMcp(cwd, { principalId, notifications: store }),
): PrincipalMcpRouter {
  const principals = new Map<string, MachineMcp>();
  const untrack = new Map<string, () => void>();
  let reporter: MachineLeaseReporter | undefined;
  let closed = false;
  const track = (principalId: string, mcp: MachineMcp) => {
    if (reporter && !untrack.has(principalId))
      untrack.set(principalId, reporter.track(principalId, mcp.workloads));
  };
  return {
    async fetch(request) {
      if (closed) return new Response('Service unavailable', { status: 503 });
      let principalId: string;
      try {
        principalId = await authenticator.authenticate(request);
      } catch {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'www-authenticate': authenticator.challenge() },
        });
      }
      if (closed) return new Response('Service unavailable', { status: 503 });
      let mcp = principals.get(principalId);
      if (!mcp) {
        mcp = createMcp(defaultCwd, principalId, notifications);
        principals.set(principalId, mcp);
        track(principalId, mcp);
      }
      return mcp.fetch(request);
    },
    attachLeaseReporter(next) {
      if (closed || reporter) return;
      reporter = next;
      for (const [principalId, mcp] of principals) track(principalId, mcp);
    },
    async close() {
      if (closed) return;
      closed = true;
      // Closing modules releases their workloads; report those releases.
      const releases = [...untrack.values()];
      untrack.clear();
      const modules = [...principals.values()];
      principals.clear();
      const results = await Promise.allSettled(
        modules.map((module) => module.close()),
      );
      for (const release of releases) release();
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close principal modules');
      }
    },
  };
}
