import type { Context } from 'hono';

import type { Router } from '@/router';
import type { SessionInfo } from '@/session/types';

export interface SessionRouteDependencies {
  router: Router;
}

export function getSessions(deps: SessionRouteDependencies) {
  return (c: Context) => {
    const sessions: SessionInfo[] = deps.router.getSessions();
    return c.json({ sessions });
  };
}
