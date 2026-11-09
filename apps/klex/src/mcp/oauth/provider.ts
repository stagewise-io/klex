import { randomBytes } from 'node:crypto';

import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  McpOAuthClientInformation,
  McpOAuthStore,
  OAuthCredentialScope,
} from './store';
import { fingerprint, OAuthTokenEndpointState } from './token-endpoint';

export type AuthorizationRedirectHandler = (
  authorizationUrl: URL,
) => void | Promise<void>;

export interface McpOAuthProviderOptions {
  clientName?: string | (() => string | undefined);
  /** Used as the client ID where the authorization server supports CIMD. */
  clientMetadataUrl?: URL;
  redirectUrl: URL;
  serverName: string;
  store: McpOAuthStore;
  signal?: AbortSignal;
  logger?: ModuleLogger;
  onAuthorizationRedirect: AuthorizationRedirectHandler;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly clientName: McpOAuthProviderOptions['clientName'];
  private readonly onAuthorizationRedirect: AuthorizationRedirectHandler;
  private readonly serverName: string;
  private readonly store: McpOAuthStore;
  private readonly signal: AbortSignal | undefined;
  private readonly logger: ModuleLogger | undefined;
  private readonly tokenEndpoint: OAuthTokenEndpointState;
  private readonly logFields: { namespace: string; serverUrl?: string };

  public readonly redirectUrl: URL;
  public readonly clientMetadataUrl?: string;

  public constructor(options: McpOAuthProviderOptions) {
    this.clientName = options.clientName;
    this.clientMetadataUrl = options.clientMetadataUrl?.toString();
    this.onAuthorizationRedirect = options.onAuthorizationRedirect;
    this.redirectUrl = options.redirectUrl;
    this.serverName = options.serverName;
    this.store = options.store;
    this.signal = options.signal;
    this.logger = options.logger;
    this.tokenEndpoint = OAuthTokenEndpointState.for(
      options.store,
      options.serverName,
    );
    const [namespace = options.serverName, serverUrl] =
      options.serverName.split('\u0000');
    this.logFields = { namespace, ...(serverUrl ? { serverUrl } : {}) };
  }

  public get clientMetadata(): OAuthClientMetadata {
    const clientName =
      typeof this.clientName === 'function'
        ? this.clientName()
        : this.clientName;
    return {
      client_name: clientName?.trim() || 'Klex Bot',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [this.redirectUrl.toString()],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  public async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<McpOAuthClientInformation | undefined> {
    this.signal?.throwIfAborted();
    return this.store.clientInformation(
      this.serverName,
      this.redirectUrl.toString(),
      context?.issuer,
    );
  }

  public async codeVerifier(): Promise<string> {
    this.signal?.throwIfAborted();
    const verifier = await this.store.codeVerifier(this.serverName);
    if (!verifier) {
      throw new Error(
        `No OAuth PKCE verifier exists for MCP server "${this.serverName}"`,
      );
    }
    return verifier;
  }

  public discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    this.signal?.throwIfAborted();
    return this.store.discoveryState(this.serverName);
  }

  public async invalidateCredentials(
    scope: OAuthCredentialScope,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    if (scope === 'client') {
      const client = await this.currentClientInformation();
      // A customer-owned app cannot be repaired by dynamically registering another.
      if (client?.klex_registered) {
        this.logger?.warn(
          { ...this.logFields, scope },
          'MCP OAuth client invalidation skipped for a configured client',
        );
        return;
      }
    }
    let storedRefreshTokenFingerprint: string | undefined;
    const { tokensCleared } = await this.store.invalidate(
      this.serverName,
      scope,
      {
        // The SDK clears tokens after any `invalid_grant`. Keep a stored
        // refresh token unless the token endpoint rejected that exact token:
        // otherwise a stale concurrent refresh deletes the winner's tokens.
        ...(scope === 'tokens'
          ? {
              shouldClearTokens: (current) => {
                if (current?.refresh_token) {
                  storedRefreshTokenFingerprint = fingerprint(
                    current.refresh_token,
                  );
                }
                return (
                  !current?.refresh_token ||
                  this.tokenEndpoint.isRejected(current.refresh_token)
                );
              },
            }
          : {}),
        signal: this.signal,
      },
    );
    const fields = {
      ...this.logFields,
      lastTokenEndpoint: this.tokenEndpoint.lastOutcome,
      scope,
      storedRefreshTokenFingerprint,
    };
    if (scope === 'tokens' && !tokensCleared) {
      this.logger?.info(
        fields,
        'MCP OAuth token invalidation skipped; stored tokens are newer than the rejected ones',
      );
    } else {
      this.logger?.warn(fields, 'MCP OAuth credentials invalidated');
    }
  }

  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.signal?.throwIfAborted();
    // Root-cause evidence: why the SDK could not continue without the user.
    this.logger?.warn(
      {
        ...this.logFields,
        lastTokenEndpoint: this.tokenEndpoint.lastOutcome,
        store: await this.store
          .summarize(this.serverName)
          .catch((error: unknown) => ({ unavailable: String(error) })),
      },
      'MCP OAuth requires user authorization',
    );
    const client = await this.currentClientInformation();
    if (client && 'scope' in client && client.scope) {
      const scopes = new Set(
        `${authorizationUrl.searchParams.get('scope') ?? ''} ${client.scope}`
          .split(/\s+/)
          .filter(Boolean),
      );
      authorizationUrl.searchParams.set('scope', [...scopes].join(' '));
    }
    this.signal?.throwIfAborted();
    await this.onAuthorizationRedirect(authorizationUrl);
  }

  public async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    await this.store.saveClientInformation(
      this.serverName,
      this.redirectUrl.toString(),
      clientInformation,
      context?.issuer,
      this.signal,
    );
  }

  public async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.signal?.throwIfAborted();
    await this.store.saveCodeVerifier(
      this.serverName,
      codeVerifier,
      this.signal,
    );
  }

  public async saveDiscoveryState(
    discoveryState: OAuthDiscoveryState,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    await this.store.saveDiscoveryState(
      this.serverName,
      discoveryState,
      this.signal,
    );
  }

  public async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    if (this.signal?.aborted) {
      // Refresh responses were already persisted by the token endpoint fetch.
      this.logger?.debug(
        this.logFields,
        'MCP OAuth token write ignored after connection close',
      );
    }
    this.signal?.throwIfAborted();
    if (this.tokenEndpoint.consumeSuperseded(tokens.access_token)) {
      this.logger?.warn(
        this.logFields,
        'MCP OAuth token write skipped; stored tokens changed during refresh',
      );
      return;
    }
    await this.store.saveTokens(
      this.serverName,
      tokens,
      context?.issuer,
      this.signal,
    );
  }

  public state(): string {
    return randomBytes(32).toString('base64url');
  }

  public tokens(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthTokens | undefined> {
    this.signal?.throwIfAborted();
    return this.store.tokens(this.serverName, context?.issuer);
  }

  private async currentClientInformation() {
    const discovery = await this.discoveryState();
    const issuer =
      discovery?.authorizationServerMetadata?.issuer ??
      discovery?.authorizationServerUrl;
    return issuer ? this.clientInformation({ issuer }) : undefined;
  }
}
