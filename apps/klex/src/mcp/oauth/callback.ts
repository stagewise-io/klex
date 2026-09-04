/**
 * Agent-owned boundary for an OAuth callback transaction. Two implementations
 * exist: the local loopback receiver (browser on the agent host) and the cloud
 * adapter, which exposes a public Klex Cloud redirect URI and resolves callback
 * parameters through the enrolled-agent channel. Neither requires changes to
 * the SDK provider.
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

/**
 * Identifies the MCP server a session is opened for. The cloud adapter needs it
 * to attribute a pending authorization to a server so it can be listed and
 * started by name; the local adapter ignores it.
 */
export interface OAuthAuthorizationSessionContext {
  /** MCP server namespace as configured. */
  serverName: string;
  /** Remote MCP server URL. */
  serverUrl: string;
}

export interface OAuthAuthorizationSessionFactory {
  start(
    context: OAuthAuthorizationSessionContext,
  ): Promise<OAuthAuthorizationSession>;
}
