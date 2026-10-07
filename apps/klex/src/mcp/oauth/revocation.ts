import {
  discoverAuthorizationServerMetadata,
  type StoredOAuthClientInformation,
} from '@modelcontextprotocol/client';
import {
  ClientSecretBasic,
  ClientSecretPost,
  None,
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
          const metadata = await discoverAuthorizationServerMetadata(issuer, {
            fetchFn: (input, init) =>
              fetch(input, { ...init, signal, redirect: 'error' }),
          });
          if (
            !metadata ||
            !('revocation_endpoint' in metadata) ||
            typeof metadata.revocation_endpoint !== 'string'
          )
            return;
          const method =
            ('token_endpoint_auth_method' in client
              ? client.token_endpoint_auth_method
              : undefined) ??
            (client.client_secret ? 'client_secret_basic' : 'none');
          const supported =
            'revocation_endpoint_auth_methods_supported' in metadata
              ? metadata.revocation_endpoint_auth_methods_supported
              : undefined;
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
                {
                  issuer: metadata.issuer,
                  revocation_endpoint: metadata.revocation_endpoint,
                },
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
