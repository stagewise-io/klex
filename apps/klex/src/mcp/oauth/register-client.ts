import { discoverOAuthServerInfo } from '@modelcontextprotocol/client';

import type { McpOAuthStore } from './store';

export interface RegisteredOAuthClient {
  clientId: string;
  clientSecret?: string;
  scope?: string;
}

/** Uses the existing issuer-bound credential format, with no store migration. */
export async function saveRegisteredOAuthClient(
  store: McpOAuthStore,
  serverName: string,
  serverUrl: string,
  redirectUrl: URL,
  client: RegisteredOAuthClient,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const discovery = await discoverOAuthServerInfo(serverUrl, {
    fetchFn: (url, init) =>
      fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      }),
  });
  const metadata = discovery.authorizationServerMetadata;
  if (
    !metadata ||
    new URL(metadata.issuer).protocol !== 'https:' ||
    new URL(metadata.token_endpoint).protocol !== 'https:'
  ) {
    throw new Error('OAuth server metadata unavailable or insecure');
  }
  const key = `${serverName}\u0000${serverUrl}`;
  // Replacing a client must never reuse the previous client's grant.
  await store.invalidate(key, 'all');
  await store.saveClientInformation(
    key,
    redirectUrl.toString(),
    {
      client_id: client.clientId,
      klex_registered: true,
      issuer: metadata.issuer,
      ...(client.clientSecret
        ? { client_secret: client.clientSecret }
        : { token_endpoint_auth_method: 'none' }),
      scope: client.scope,
      redirect_uris: [redirectUrl.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    metadata.issuer,
  );
  await store.saveDiscoveryState(key, discovery);
}
