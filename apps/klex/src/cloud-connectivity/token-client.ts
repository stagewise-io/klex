import * as oauth from 'oauth4webapi';

import type { ModuleLogger } from '@stagewise/logger';

export interface TokenClient {
  getAccessToken(resource: string, scopes: string[]): Promise<string>;
  invalidate(resource: string): void;
  close(): void;
}

export interface TokenClientDependencies {
  logger: ModuleLogger;
  cloudBaseUrl: string;
  clientId: string;
  privateKey: CryptoKey;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const SAFETY_BUFFER_MS = 60_000;

// oauth4webapi signs Ed25519 assertions with alg "Ed25519" (Web Crypto naming).
// JWS spec requires "EdDSA". This hook remaps the header before signing.
const remapEd25519: oauth.ModifyAssertionOptions = {
  [oauth.modifyAssertion]: (header) => {
    if (header.alg === 'Ed25519') {
      header.alg = 'EdDSA';
    }
  },
};

class TokenClientModule implements TokenClient {
  private readonly cache = new Map<string, CachedToken>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Map<string, Promise<string>>();
  private serverMetadata: oauth.AuthorizationServer | null = null;
  private closed = false;

  constructor(private readonly deps: TokenClientDependencies) {}

  async getAccessToken(resource: string, scopes: string[]): Promise<string> {
    if (this.closed) throw new Error('Token client is closed');

    const cached = this.cache.get(resource);
    if (cached && cached.expiresAt > Date.now() + SAFETY_BUFFER_MS) {
      return cached.token;
    }

    // Deduplicate concurrent requests for the same resource
    const existing = this.inflight.get(resource);
    if (existing) return existing;

    const promise = this.fetchToken(resource, scopes).finally(() => {
      this.inflight.delete(resource);
    });
    this.inflight.set(resource, promise);
    return promise;
  }

  invalidate(resource: string): void {
    this.cache.delete(resource);
    this.clearRefreshTimer(resource);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.cache.clear();
    this.inflight.clear();
  }

  private async fetchToken(
    resource: string,
    scopes: string[],
  ): Promise<string> {
    const metadata = await this.ensureMetadata();
    const client: oauth.Client = {
      client_id: this.deps.clientId,
      token_endpoint_auth_method: 'private_key_jwt',
    };
    const clientAuth = oauth.PrivateKeyJwt(this.deps.privateKey, remapEd25519);

    const params = new URLSearchParams();
    params.set('scope', scopes.join(' '));
    params.set('resource', resource);

    let response: Response;
    try {
      response = await oauth.clientCredentialsGrantRequest(
        metadata,
        client,
        clientAuth,
        params,
      );
    } catch (error) {
      throw new Error(
        `Token request to ${this.deps.cloudBaseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    let result: oauth.TokenEndpointResponse;
    try {
      result = await oauth.processClientCredentialsResponse(
        metadata,
        client,
        response,
      );
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError) {
        const body = error.error;
        const desc = error.error_description;
        throw new Error(
          `Token request rejected: ${body}${desc ? ` — ${desc}` : ''}`,
          { cause: error },
        );
      }
      throw new Error(
        `Token response processing failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const accessToken = result.access_token;
    const expiresIn = result.expires_in ?? 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    this.cache.set(resource, { token: accessToken, expiresAt });
    this.scheduleRefresh(resource, scopes, expiresIn);

    this.deps.logger.debug(
      { resource, expiresIn },
      'Token acquired and cached',
    );

    return accessToken;
  }

  private scheduleRefresh(
    resource: string,
    scopes: string[],
    expiresIn: number,
  ): void {
    if (this.closed) return;
    this.clearRefreshTimer(resource);
    // Refresh at 80% of TTL
    const refreshDelay = Math.floor(expiresIn * 0.8 * 1000);
    const timer = setTimeout(() => {
      if (this.closed) return;
      this.fetchToken(resource, scopes).catch((error: unknown) => {
        this.deps.logger.warn(
          { error, resource },
          'Proactive token refresh failed',
        );
      });
    }, refreshDelay);
    timer.unref?.();
    this.refreshTimers.set(resource, timer);
  }

  private clearRefreshTimer(resource: string): void {
    const timer = this.refreshTimers.get(resource);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(resource);
    }
  }

  private async ensureMetadata(): Promise<oauth.AuthorizationServer> {
    if (this.serverMetadata) return this.serverMetadata;

    const issuerUrl = new URL('/api/auth', this.deps.cloudBaseUrl);
    const discoveryUrl = new URL(
      '/api/auth/.well-known/oauth-authorization-server',
      this.deps.cloudBaseUrl,
    );

    try {
      const response = await fetch(discoveryUrl);
      this.serverMetadata = await oauth.processDiscoveryResponse(
        issuerUrl,
        response,
      );
    } catch (error) {
      this.deps.logger.warn(
        { error },
        'OAuth discovery failed — falling back to manual metadata',
      );
      // Manual fallback: construct minimal metadata
      const tokenEndpoint = new URL(
        '/api/auth/oauth2/token',
        this.deps.cloudBaseUrl,
      ).toString();
      this.serverMetadata = {
        issuer: issuerUrl.toString(),
        token_endpoint: tokenEndpoint,
      };
    }

    return this.serverMetadata;
  }
}

export function createTokenClient(deps: TokenClientDependencies): TokenClient {
  return new TokenClientModule(deps);
}
