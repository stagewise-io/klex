import { randomBytes } from 'node:crypto';

import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import type {
  McpOAuthClientInformation,
  McpOAuthStore,
  OAuthCredentialScope,
} from './store';

export type AuthorizationRedirectHandler = (
  authorizationUrl: URL,
) => void | Promise<void>;

export interface McpOAuthProviderOptions {
  redirectUrl: URL;
  serverName: string;
  store: McpOAuthStore;
  signal?: AbortSignal;
  onAuthorizationRedirect: AuthorizationRedirectHandler;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly onAuthorizationRedirect: AuthorizationRedirectHandler;
  private readonly serverName: string;
  private readonly store: McpOAuthStore;
  private readonly signal?: AbortSignal;

  public readonly redirectUrl: URL;

  public constructor(options: McpOAuthProviderOptions) {
    this.onAuthorizationRedirect = options.onAuthorizationRedirect;
    this.redirectUrl = options.redirectUrl;
    this.serverName = options.serverName;
    this.store = options.store;
    this.signal = options.signal;
  }

  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Klex Bot',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [this.redirectUrl.toString()],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  public async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<McpOAuthClientInformation | undefined> {
    return this.store.clientInformation(
      this.serverName,
      this.redirectUrl.toString(),
      context?.issuer,
    );
  }

  public async codeVerifier(): Promise<string> {
    const verifier = await this.store.codeVerifier(this.serverName);
    if (!verifier) {
      throw new Error(
        `No OAuth PKCE verifier exists for MCP server "${this.serverName}"`,
      );
    }
    return verifier;
  }

  public discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.store.discoveryState(this.serverName);
  }

  public async invalidateCredentials(
    scope: OAuthCredentialScope,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    if (scope === 'client') {
      const client = await this.currentClientInformation();
      // A customer-owned app cannot be repaired by dynamically registering another.
      if (client?.klex_registered) return;
    }
    this.signal?.throwIfAborted();
    await this.store.invalidate(this.serverName, scope);
  }

  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.signal?.throwIfAborted();
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

  public saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    return this.store.saveClientInformation(
      this.serverName,
      this.redirectUrl.toString(),
      clientInformation,
      context?.issuer,
    );
  }

  public saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.signal?.throwIfAborted();
    return this.store.saveCodeVerifier(this.serverName, codeVerifier);
  }

  public saveDiscoveryState(
    discoveryState: OAuthDiscoveryState,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    return this.store.saveDiscoveryState(this.serverName, discoveryState);
  }

  public saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    return this.store.saveTokens(this.serverName, tokens, context?.issuer);
  }

  public state(): string {
    return randomBytes(32).toString('base64url');
  }

  public tokens(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthTokens | undefined> {
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
