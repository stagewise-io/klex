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
 * Klex Cloud's Client ID Metadata Document. Providers that support CIMD (such
 * as Vercel's MCP, which limits dynamic registration to reviewed clients)
 * accept this URL as the client ID. It must stay in sync with the cloud route.
 */
export const CLOUD_OAUTH_CLIENT_METADATA_PATH = '/v1/mcp-oauth/client.json';

/**
 * Returns the calling agent's own metadata document URL, which carries the
 * agent's name and logo. Older Cloud versions answer 404.
 */
export const CLOUD_AGENT_OAUTH_CLIENT_PATH = '/v1/agent/mcp-oauth/client';

/** Resolves the agent's metadata document URL, or undefined to use Klex's. */
export type AgentClientMetadataUrlResolver = (
  cloudBaseUrl: string,
) => Promise<URL | undefined>;

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
  resolveAgentClientMetadataUrl?: AgentClientMetadataUrlResolver;
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
      const cloudBaseUrl = options.getCloudBaseUrl();
      const redirectUrl = cloudCallbackUrl(cloudBaseUrl);
      // CIMD requires HTTPS; a local HTTP Cloud keeps dynamic registration.
      const clientMetadataUrl =
        redirectUrl.protocol === 'https:'
          ? ((await options.resolveAgentClientMetadataUrl?.(cloudBaseUrl)) ??
            cloudUrl(cloudBaseUrl, CLOUD_OAUTH_CLIENT_METADATA_PATH))
          : undefined;
      return {
        redirectUrl,
        ...(clientMetadataUrl && { clientMetadataUrl }),
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

/**
 * Asks Cloud for the agent's metadata document URL. A found URL is cached for
 * the process, since an agent keeps its Cloud identity. A 404 (older Cloud or
 * unknown agent) and any failure fall back to Klex's shared document, so a
 * Cloud hiccup never blocks a connection. Misses are retried next time.
 */
export function createAgentClientMetadataUrlResolver(options: {
  getAccessToken: (resource: string, scopes: string[]) => Promise<string>;
  onError?: (error: unknown) => void;
  fetch?: typeof fetch;
}): AgentClientMetadataUrlResolver {
  const fetchImpl = options.fetch ?? fetch;
  const cache = new Map<string, URL>();
  return async (cloudBaseUrl) => {
    const cached = cache.get(cloudBaseUrl);
    if (cached) return cached;
    try {
      const token = await options.getAccessToken(
        cloudUrl(cloudBaseUrl, '/v1').toString(),
        ['agent:access'],
      );
      const response = await fetchImpl(
        cloudUrl(cloudBaseUrl, CLOUD_AGENT_OAUTH_CLIENT_PATH),
        {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`Cloud answered ${response.status}`);
      const body: unknown = await response.json();
      const value =
        typeof body === 'object' && body !== null && 'clientMetadataUrl' in body
          ? body.clientMetadataUrl
          : undefined;
      if (typeof value !== 'string')
        throw new Error('Cloud response has no clientMetadataUrl');
      const url = new URL(value);
      if (url.protocol !== 'https:')
        throw new Error('Agent client metadata URL is not HTTPS');
      cache.set(cloudBaseUrl, url);
      return url;
    } catch (error) {
      options.onError?.(error);
      return undefined;
    }
  };
}

export function cloudCallbackUrl(cloudBaseUrl: string): URL {
  return cloudUrl(cloudBaseUrl, CLOUD_OAUTH_CALLBACK_PATH);
}

function cloudUrl(cloudBaseUrl: string, path: string): URL {
  return new URL(`${cloudBaseUrl.replace(/\/$/, '')}${path}`);
}
