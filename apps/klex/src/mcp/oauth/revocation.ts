import {
  buildDiscoveryUrls,
  type StoredOAuthClientInformation,
} from '@modelcontextprotocol/client';
import {
  ClientSecretBasic,
  ClientSecretPost,
  None,
  processDiscoveryResponse,
  processRevocationResponse,
  revocationRequest,
} from 'oauth4webapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { ServerOAuthState } from './store';

/** Local credentials must already be removed; remote revocation is best effort. */
export async function revokeOAuthCredentials(
  states: ServerOAuthState[],
  namespace: string,
  logger: ModuleLogger,
): Promise<void> {
  const signal = AbortSignal.timeout(5_000);
  const warn = () =>
    logger.warn(
      { namespace },
      'MCP OAuth token revocation failed; credentials were removed locally',
    );
  await Promise.all(
    states.flatMap((state) =>
      Object.entries(state.tokensByIssuer).map(async ([key, tokens]) => {
        try {
          const issuer =
            key === '__default__'
              ? state.discoveryState?.authorizationServerUrl
              : key;
          const client = state.clientInformationByIssuer[key];
          if (
            !issuer ||
            !client ||
            (tokens.issuer && tokens.issuer !== issuer) ||
            (client.issuer && client.issuer !== issuer) ||
            new URL(issuer).protocol !== 'https:'
          ) {
            warn();
            return;
          }
          const metadata = await discoverRevocationMetadata(issuer, signal);
          if (!metadata?.revocation_endpoint) return;
          const method =
            ('token_endpoint_auth_method' in client
              ? client.token_endpoint_auth_method
              : undefined) ??
            (client.client_secret ? 'client_secret_basic' : 'none');
          const supported = metadata.revocation_endpoint_auth_methods_supported;
          if (Array.isArray(supported) && !supported.includes(method)) {
            warn();
            return;
          }
          const authenticate = clientAuthentication(client, method);
          // Some providers revoke related access tokens with the refresh token;
          // revoke both because RFC 7009 does not require that behavior.
          for (const hint of ['refresh_token', 'access_token'] as const) {
            const token = tokens[hint];
            if (!token) continue;
            try {
              const response = await revocationRequest(
                metadata,
                { client_id: client.client_id },
                authenticate,
                token,
                {
                  signal,
                  additionalParameters: { token_type_hint: hint },
                },
              );
              await processRevocationResponse(response);
            } catch {
              warn();
            }
          }
        } catch {
          // Provider responses and request errors may contain tokens or client secrets.
          warn();
        }
      }),
    ),
  );
}

// The SDK's OIDC metadata parser drops revocation fields.
async function discoverRevocationMetadata(issuer: string, signal: AbortSignal) {
  for (const { url } of buildDiscoveryUrls(issuer)) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
      redirect: 'error',
    });
    if (
      (response.status >= 400 && response.status < 500) ||
      response.status === 502
    ) {
      await response.body?.cancel();
      continue;
    }
    return processDiscoveryResponse(new URL(issuer), response);
  }
}

function clientAuthentication(
  client: StoredOAuthClientInformation,
  method: string,
) {
  if (method === 'none') return None();
  if (client.client_secret) {
    if (method === 'client_secret_basic')
      return ClientSecretBasic(client.client_secret);
    if (method === 'client_secret_post')
      return ClientSecretPost(client.client_secret);
  }
  throw new Error('Unsupported OAuth revocation authentication method');
}
