/**
 * Agent-owned boundary for an OAuth callback transaction. A future cloud
 * adapter can expose its public redirect URI and resolve callback parameters
 * through the enrolled-agent channel without changing the SDK provider.
 */
export interface OAuthAuthorizationSession {
  readonly redirectUrl: URL;
  authorize(options: {
    authorizationUrl: URL;
    signal: AbortSignal;
    state: string;
  }): Promise<URLSearchParams>;
  close(): Promise<void>;
}

export interface OAuthAuthorizationSessionFactory {
  start(): Promise<OAuthAuthorizationSession>;
}
