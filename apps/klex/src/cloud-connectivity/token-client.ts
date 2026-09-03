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
  privateKeyKid: string;
  allowDangerousUnsecureCloud?: boolean;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface TokenFailureState {
  attempt: number;
  nextAttemptAt: number;
}

const SAFETY_BUFFER_MS = 60_000;
const MAX_DIAGNOSTIC_BODY_LENGTH = 512;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const CACHE_KEY_SEPARATOR = '\0';

function createCacheKey(resource: string, scopes: string[]): string {
  const normalizedScopes = [...new Set(scopes)].sort();
  return `${resource}${CACHE_KEY_SEPARATOR}${normalizedScopes.join(' ')}`;
}

function isCacheKeyForResource(cacheKey: string, resource: string): boolean {
  return cacheKey.startsWith(`${resource}${CACHE_KEY_SEPARATOR}`);
}

const REDACTED = '[redacted]';

/**
 * Credential-bearing fields that must never reach a log.
 *
 * Covers both directions: fields an authorization server returns
 * (`access_token`, `refresh_token`, `id_token`) and fields we submit that a
 * server or intervening proxy may echo back in an error body
 * (`client_assertion` is our `private_key_jwt`, so it is at least as sensitive
 * as the token it buys).
 */
const SENSITIVE_FIELDS = [
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'client_assertion',
  'code',
  'device_code',
];

// Prevents `code` from matching inside `error_code`, which would discard
// diagnostics we actually want to keep.
const KEY_BOUNDARY = '(?<![\\w-])';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_FIELDS.includes(key.toLowerCase());
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactJsonValue(nested),
      ]),
    );
  }
  return value;
}

/**
 * Scans arbitrary text. Used for non-JSON bodies (HTML proxy pages,
 * form-encoded errors) and as a second pass over serialised JSON, where a
 * secret can sit inside an innocently named string value such as
 * `error_description`.
 */
function redactCredentialText(text: string): string {
  let redacted = text;
  for (const field of SENSITIVE_FIELDS) {
    // Key/value pairs, tolerating single quotes and unquoted keys.
    redacted = redacted.replace(
      new RegExp(
        `${KEY_BOUNDARY}(["']?${field}["']?\\s*:\\s*)(["'])(?:[^"'\\\\]|\\\\.)*(["'])`,
        'gi',
      ),
      `$1$2${REDACTED}$3`,
    );
    // Form-encoded: access_token=...
    redacted = redacted.replace(
      new RegExp(`${KEY_BOUNDARY}(${field}=)[^&\\s]+`, 'gi'),
      `$1${REDACTED}`,
    );
  }
  return redacted;
}

/**
 * Replaces credential values with `[redacted]`.
 *
 * A response can be non-conformant yet still carry a live token — for example
 * a success body with a malformed `expires_in`. Diagnostics reach
 * `logger.error`, so token values must never survive into them.
 *
 * Structural redaction is preferred over a raw-text scan because `JSON.parse`
 * normalises escaped key spellings (`access\u005ftoken` decodes to
 * `access_token`), which a text regex cannot see. The text pass still runs
 * afterwards to catch secrets embedded in string values.
 */
function redactCredentials(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      return redactCredentialText(JSON.stringify(redactJsonValue(parsed)));
    }
  } catch {
    // Not JSON — the text scanner is the only available defence.
  }
  return redactCredentialText(text);
}

/**
 * Summarises an HTTP response for error messages.
 *
 * `oauth4webapi` reports a non-conformant token response without the status
 * code or body, which makes a transient edge failure (502/503/504, an HTML
 * proxy error page) indistinguishable from an authorization-server
 * regression. Retries then mask the difference entirely.
 *
 * The caller must pass a clone taken before the body was consumed.
 */
function safeClone(response: Response): Response | null {
  try {
    return response.clone();
  } catch {
    // A clone failure must never mask the original OAuth error.
    return null;
  }
}

async function describeResponse(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? 'unknown';
  let body: string;
  try {
    body = redactCredentials((await response.text()).trim());
  } catch (error) {
    body = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
  const snippet =
    body.length > MAX_DIAGNOSTIC_BODY_LENGTH
      ? `${body.slice(0, MAX_DIAGNOSTIC_BODY_LENGTH)}… [truncated]`
      : body || '<empty>';
  return `HTTP ${response.status} ${response.statusText || '-'}, content-type: ${contentType}, body: ${snippet}`;
}

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
  private readonly inflight = new Map<string, Promise<CachedToken>>();
  private readonly failureStates = new Map<string, TokenFailureState>();
  private readonly retryWaiters = new Map<NodeJS.Timeout, () => void>();
  private serverMetadata: oauth.AuthorizationServer | null = null;
  private closed = false;
  private readonly insecureOptions:
    | { [oauth.allowInsecureRequests]: true }
    | undefined;

  constructor(private readonly deps: TokenClientDependencies) {
    if (deps.allowDangerousUnsecureCloud) {
      this.insecureOptions = { [oauth.allowInsecureRequests]: true };
    }
  }

  async getAccessToken(resource: string, scopes: string[]): Promise<string> {
    try {
      const cached = await this.getTokenInternal(resource, scopes);
      return cached.token;
    } catch (error) {
      const failureState = this.failureStates.get(
        createCacheKey(resource, scopes),
      );
      this.deps.logger.error(
        {
          error,
          resource,
          scopes,
          retryAttempt: failureState?.attempt,
          retryDelayMs: failureState
            ? Math.max(0, failureState.nextAttemptAt - Date.now())
            : undefined,
        },
        'Access token exchange failed',
      );
      throw error;
    }
  }

  private async getTokenInternal(
    resource: string,
    scopes: string[],
  ): Promise<CachedToken> {
    if (this.closed) throw new Error('Token client is closed');

    const cacheKey = createCacheKey(resource, scopes);

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + SAFETY_BUFFER_MS) {
      return cached;
    }

    // Deduplicate concurrent requests for the same resource
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const promise = this.fetchTokenWithBackoff(
      resource,
      scopes,
      cacheKey,
    ).finally(() => {
      this.inflight.delete(cacheKey);
    });
    this.inflight.set(cacheKey, promise);
    return promise;
  }

  invalidate(resource: string): void {
    for (const cacheKey of this.cache.keys()) {
      if (isCacheKeyForResource(cacheKey, resource)) {
        this.cache.delete(cacheKey);
      }
    }
    for (const cacheKey of this.refreshTimers.keys()) {
      if (isCacheKeyForResource(cacheKey, resource)) {
        this.clearRefreshTimer(cacheKey);
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    for (const wake of this.retryWaiters.values()) wake();
    this.retryWaiters.clear();
    this.failureStates.clear();
    this.cache.clear();
    this.inflight.clear();
  }

  private async fetchTokenWithBackoff(
    resource: string,
    scopes: string[],
    cacheKey: string,
  ): Promise<CachedToken> {
    await this.waitForRetryWindow(cacheKey);

    try {
      const token = await this.fetchToken(resource, scopes, cacheKey);
      this.failureStates.delete(cacheKey);
      return token;
    } catch (error) {
      const attempt = (this.failureStates.get(cacheKey)?.attempt ?? 0) + 1;
      const delay = Math.min(
        RETRY_INITIAL_MS * 2 ** (attempt - 1),
        RETRY_MAX_MS,
      );
      this.failureStates.set(cacheKey, {
        attempt,
        nextAttemptAt: Date.now() + delay,
      });
      throw error;
    }
  }

  private async waitForRetryWindow(cacheKey: string): Promise<void> {
    const failureState = this.failureStates.get(cacheKey);
    const delay = failureState
      ? Math.max(0, failureState.nextAttemptAt - Date.now())
      : 0;
    if (delay === 0) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.retryWaiters.delete(timer);
        resolve();
      }, delay);
      timer.unref?.();
      this.retryWaiters.set(timer, () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (this.closed) throw new Error('Token client is closed');
  }

  private async fetchToken(
    resource: string,
    scopes: string[],
    cacheKey: string,
  ): Promise<CachedToken> {
    const metadata = await this.ensureMetadata();
    const client: oauth.Client = {
      client_id: this.deps.clientId,
      token_endpoint_auth_method: 'private_key_jwt',
    };
    const clientAuth = oauth.PrivateKeyJwt(
      { key: this.deps.privateKey, kid: this.deps.privateKeyKid },
      remapEd25519,
    );

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
        this.insecureOptions,
      );
    } catch (error) {
      throw new Error(
        `Token request to ${this.deps.cloudBaseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // Clone before processing: the body can only be consumed once, and
    // `processClientCredentialsResponse` consumes it. Without this clone the
    // failure path has no status code and no body to report.
    const diagnosticResponse = safeClone(response);

    let result: oauth.TokenEndpointResponse;
    try {
      result = await oauth.processClientCredentialsResponse(
        metadata,
        client,
        response,
      );
    } catch (error) {
      const diagnostics = diagnosticResponse
        ? await describeResponse(diagnosticResponse).catch(
            (readError: unknown) =>
              `diagnostics unavailable: ${readError instanceof Error ? readError.message : String(readError)}`,
          )
        : 'diagnostics unavailable: response could not be cloned';

      if (error instanceof oauth.ResponseBodyError) {
        const body = error.error;
        const desc = error.error_description;
        throw new Error(
          `Token request rejected: ${body}${desc ? ` — ${desc}` : ''} (${diagnostics})`,
          { cause: error },
        );
      }
      throw new Error(
        `Token response processing failed: ${error instanceof Error ? error.message : String(error)} (${diagnostics})`,
        { cause: error },
      );
    }

    const accessToken = result.access_token;
    const expiresIn = result.expires_in ?? 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    this.cache.set(cacheKey, { token: accessToken, expiresAt });
    this.scheduleRefresh(resource, scopes, cacheKey, expiresIn);

    this.deps.logger.debug(
      { resource, expiresIn },
      'Token acquired and cached',
    );

    return { token: accessToken, expiresAt };
  }

  private scheduleRefresh(
    resource: string,
    scopes: string[],
    cacheKey: string,
    expiresIn: number,
  ): void {
    if (this.closed) return;
    this.clearRefreshTimer(cacheKey);
    // Refresh at 80% of TTL
    const refreshDelay = Math.floor(expiresIn * 0.8 * 1000);
    const timer = setTimeout(() => {
      if (this.closed) return;
      void this.refreshWithRetry(resource, scopes, cacheKey, 1);
    }, refreshDelay);
    timer.unref?.();
    this.refreshTimers.set(cacheKey, timer);
  }

  private async refreshWithRetry(
    resource: string,
    scopes: string[],
    cacheKey: string,
    attempt: number,
  ): Promise<void> {
    if (this.closed) return;
    try {
      await this.fetchTokenWithBackoff(resource, scopes, cacheKey);
      // fetchToken success → scheduleRefresh already set the next proactive timer
    } catch (error) {
      if (this.closed) return;
      this.deps.logger.warn(
        { error, resource, attempt },
        'Proactive token refresh failed — retrying',
      );
      // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 30s, 30s, ...
      const baseDelay = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
      const jitter = Math.floor(Math.random() * 1_000);
      const timer = setTimeout(() => {
        void this.refreshWithRetry(resource, scopes, cacheKey, attempt + 1);
      }, baseDelay + jitter);
      timer.unref?.();
      this.refreshTimers.set(cacheKey, timer);
    }
  }

  private clearRefreshTimer(cacheKey: string): void {
    const timer = this.refreshTimers.get(cacheKey);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(cacheKey);
    }
  }

  private async ensureMetadata(): Promise<oauth.AuthorizationServer> {
    if (this.serverMetadata) return this.serverMetadata;

    // The OAuth authorization server issuer is always
    // `${cloudBaseUrl}/api/auth` — Better Auth is mounted at /api/auth and
    // all OAuth endpoints (discovery, token, jwks, etc.) are served under
    // that path.
    const authServerUrl = `${this.deps.cloudBaseUrl.replace(/\/$/, '')}/api/auth`;
    const issuerUrl = new URL(authServerUrl);

    try {
      // Better Auth exposes discovery below the issuer path. OIDC discovery
      // appends the well-known path, yielding
      // `/api/auth/.well-known/openid-configuration`. OAuth discovery would
      // prepend it and request the unsupported
      // `/.well-known/oauth-authorization-server/api/auth` path.
      const response = await oauth.discoveryRequest(issuerUrl, {
        algorithm: 'oidc',
        ...this.insecureOptions,
      });
      this.serverMetadata = await oauth.processDiscoveryResponse(
        issuerUrl,
        response,
      );
    } catch (error) {
      this.deps.logger.warn(
        { error },
        'OAuth discovery failed — falling back to manual metadata',
      );
      const tokenEndpoint = `${authServerUrl}/oauth2/token`;
      this.serverMetadata = {
        issuer: authServerUrl,
        token_endpoint: tokenEndpoint,
      };
    }

    return this.serverMetadata;
  }
}

export function createTokenClient(deps: TokenClientDependencies): TokenClient {
  return new TokenClientModule(deps);
}
