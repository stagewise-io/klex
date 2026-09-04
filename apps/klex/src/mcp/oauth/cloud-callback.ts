import type {
  OAuthAuthorizationSession,
  OAuthAuthorizationSessionFactory,
} from './callback';
import type { McpPendingAuthorizationRegistry } from './pending-authorizations';

/**
 * Public Klex Cloud endpoint that third-party authorization servers redirect
 * to. It must stay in sync with the cloud route: the URL is baked into dynamic
 * client registrations, so changing it forces re-registration everywhere.
 */
export const CLOUD_OAUTH_CALLBACK_PATH = '/v1/mcp-oauth/callback';

/**
 * Cloud authorizations are user-driven and asynchronous — the user may add a
 * server and consent minutes later — so the window is far wider than the local
 * browser flow's five minutes.
 */
export const CLOUD_AUTHORIZATION_TIMEOUT_MS = 15 * 60_000;

export interface CloudOAuthAuthorizationSessionFactoryOptions {
  registry: McpPendingAuthorizationRegistry;
  /** Cloud API base URL, as configured for cloud connectivity. */
  getCloudBaseUrl: () => string;
  timeoutMs?: number;
}

/**
 * Authorization sessions that route consent through Klex Cloud instead of a
 * browser on the agent host. The session publishes the public cloud redirect
 * URI and parks on the pending-authorization registry until the cloud delivers
 * the callback parameters over the tunnel. PKCE verifiers, client secrets and
 * tokens never leave the agent.
 */
export function createCloudOAuthAuthorizationSessionFactory(
  options: CloudOAuthAuthorizationSessionFactoryOptions,
): OAuthAuthorizationSessionFactory {
  const timeoutMs = options.timeoutMs ?? CLOUD_AUTHORIZATION_TIMEOUT_MS;
  return {
    start: async (context): Promise<OAuthAuthorizationSession> => {
      const redirectUrl = cloudCallbackUrl(options.getCloudBaseUrl());
      return {
        redirectUrl,
        authorize: ({ authorizationUrl, signal, state }) =>
          options.registry.register(
            {
              serverName: context.serverName,
              serverUrl: context.serverUrl,
              authorizationUrl: authorizationUrl.toString(),
              state,
            },
            { signal, timeoutMs },
          ),
        // Intentionally a no-op: `connectMcpServer` closes the session in a
        // `finally` block while the authorization promise is still awaited by
        // the caller, so cancelling the pending entry here would abort every
        // cloud authorization immediately. The registry drops entries itself
        // when they settle, time out or are aborted.
        close: async () => undefined,
      };
    },
  };
}

export function cloudCallbackUrl(cloudBaseUrl: string): URL {
  return new URL(
    `${cloudBaseUrl.replace(/\/$/, '')}${CLOUD_OAUTH_CALLBACK_PATH}`,
  );
}
