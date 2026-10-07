import { randomBytes } from 'node:crypto';

import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import type { McpOAuthStore, OAuthCredentialScope } from './store';

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
  private readonly signal: AbortSignal | undefined;

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
  ): Promise<StoredOAuthClientInformation | undefined> {
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

  public invalidateCredentials(scope: OAuthCredentialScope): Promise<void> {
    return this.store.invalidate(this.serverName, scope, this.signal);
  }

  public redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    this.signal?.throwIfAborted();
    return this.onAuthorizationRedirect(authorizationUrl);
  }

  public saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    return this.store.saveClientInformation(
      this.serverName,
      this.redirectUrl.toString(),
      clientInformation,
      context?.issuer,
      this.signal,
    );
  }

  public saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.store.saveCodeVerifier(
      this.serverName,
      codeVerifier,
      this.signal,
    );
  }

  public saveDiscoveryState(
    discoveryState: OAuthDiscoveryState,
  ): Promise<void> {
    return this.store.saveDiscoveryState(
      this.serverName,
      discoveryState,
      this.signal,
    );
  }

  public saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    return this.store.saveTokens(
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
}
