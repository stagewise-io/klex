import { createMachineMcp, type MachineMcp } from '../mcp.js';
import type { MachineAuthenticator } from './auth.js';

export interface PrincipalMcpRouter {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createPrincipalMcpRouter(
  authenticator: MachineAuthenticator,
  defaultCwd: string,
  createMcp: (cwd: string) => MachineMcp = createMachineMcp,
): PrincipalMcpRouter {
  const principals = new Map<string, MachineMcp>();
  let closed = false;
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
        mcp = createMcp(defaultCwd);
        principals.set(principalId, mcp);
      }
      return mcp.fetch(request);
    },
    async close() {
      if (closed) return;
      closed = true;
      const modules = [...principals.values()];
      principals.clear();
      const results = await Promise.allSettled(
        modules.map((module) => module.close()),
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close principal modules');
      }
    },
  };
}
