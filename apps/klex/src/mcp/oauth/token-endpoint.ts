import { createHash } from 'node:crypto';

import type { ModuleLogger } from '@stagewise/logger';

import {
  type McpOAuthStore,
  parseTokenResponse,
  type RefreshedTokenPersistence,
} from './store';

/**
 * Late refreshes that reuse a just-rotated token get the same response. Only
 * rotating responses are replayed: the server rejects the old token anyway,
 * while a non-rotating refresh can simply be sent again.
 */
const REPLAY_WINDOW_MS = 60_000;
/** The SDK sends token requests without a signal; a hung request would hold the refresh lock. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_DESCRIPTION_LENGTH = 300;
/** Errors that prove the refresh token itself can no longer be used. */
const REFRESH_TOKEN_REJECTIONS = new Set([
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
]);

export interface TokenEndpointOutcome {
  at: string;
  grantType: string;
  result: 'success' | 'rejected' | 'network_error' | 'replayed';
  status?: number;
  oauthError?: string;
  durationMs?: number;
}

interface ReplayEntry {
  body: string;
  expiresAt: number;
  headers: Headers;
  status: number;
  statusText: string;
}

/**
 * Process-local refresh coordination for one OAuth credential key.
 *
 * Several MCP requests can see the same expired access token and start a
 * refresh concurrently. Providers that rotate refresh tokens accept only the
 * first refresh; the others receive `invalid_grant`, after which the SDK clears
 * every stored token, including the ones the winning refresh just saved.
 */
export class OAuthTokenEndpointState {
  private static readonly states = new WeakMap<
    McpOAuthStore,
    Map<string, OAuthTokenEndpointState>
  >();

  public lastOutcome: TokenEndpointOutcome | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly rejected = new Set<string>();
  private readonly replays = new Map<string, ReplayEntry>();
  /** Access tokens from refresh responses that lost the compare-and-swap. */
  private readonly superseded = new Set<string>();

  public static for(
    store: McpOAuthStore,
    serverName: string,
  ): OAuthTokenEndpointState {
    let byServer = OAuthTokenEndpointState.states.get(store);
    if (!byServer) {
      byServer = new Map();
      OAuthTokenEndpointState.states.set(store, byServer);
    }
    let state = byServer.get(serverName);
    if (!state) {
      state = new OAuthTokenEndpointState();
      byServer.set(serverName, state);
    }
    return state;
  }

  public exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public isRejected(refreshToken: string): boolean {
    return this.rejected.has(hashToken(refreshToken));
  }

  public markRejected(refreshToken: string): void {
    this.rejected.add(hashToken(refreshToken));
  }

  public markSuperseded(accessToken: string): void {
    this.superseded.add(hashToken(accessToken));
  }

  /** True once for a superseded token set, so the SDK write can be skipped. */
  public consumeSuperseded(accessToken: string): boolean {
    return this.superseded.delete(hashToken(accessToken));
  }

  public remember(refreshToken: string, response: Response, body: string) {
    this.replays.set(hashToken(refreshToken), {
      body,
      expiresAt: Date.now() + REPLAY_WINDOW_MS,
      headers: new Headers(response.headers),
      status: response.status,
      statusText: response.statusText,
    });
  }

  public replay(refreshToken: string): Response | undefined {
    const now = Date.now();
    for (const [key, entry] of this.replays) {
      if (entry.expiresAt <= now) this.replays.delete(key);
    }
    const entry = this.replays.get(hashToken(refreshToken));
    if (!entry) return undefined;
    // Only successful refresh responses (200) are remembered, so a body is valid.
    return new Response(entry.body, {
      headers: entry.headers,
      status: entry.status,
      statusText: entry.statusText,
    });
  }
}

export interface OAuthTokenEndpointFetchOptions {
  logger?: ModuleLogger;
  namespace: string;
  serverName: string;
  serverUrl: string;
  store: McpOAuthStore;
}

/**
 * Wraps the fetch used by the SDK for OAuth token requests:
 *
 * - serializes refresh requests per credential key and replays a recent
 *   successful response to callers holding the same, now-rotated token;
 * - persists rotated tokens before returning to the SDK, so a connection that
 *   closes mid-refresh cannot discard the only valid refresh token;
 * - records rejected refresh tokens so token invalidation can tell a stale
 *   loser from a genuinely revoked grant;
 * - logs every token endpoint outcome without secrets.
 *
 * Non-token requests pass through unchanged.
 */
export function createOAuthTokenEndpointFetch(
  next: typeof fetch,
  options: OAuthTokenEndpointFetchOptions,
): typeof fetch {
  const state = OAuthTokenEndpointState.for(options.store, options.serverName);
  const logFields = {
    namespace: options.namespace,
    serverUrl: options.serverUrl,
  };

  const send = async (
    input: Parameters<typeof fetch>[0],
    init: RequestInit,
    grantType: string,
  ) => {
    const startedAt = Date.now();
    const signal = init.signal
      ? AbortSignal.any([
          init.signal,
          AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
    try {
      const response = await next(input, { ...init, signal });
      const body = await response.text();
      return { body, durationMs: Date.now() - startedAt, response };
    } catch (error) {
      state.lastOutcome = {
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        grantType,
        result: 'network_error',
      };
      options.logger?.warn(
        {
          ...logFields,
          durationMs: Date.now() - startedAt,
          error,
          grantType,
        },
        'MCP OAuth token request failed before a response',
      );
      throw error;
    }
  };

  const recordRejection = (
    grantType: string,
    status: number,
    body: string,
    durationMs: number,
    extra: Record<string, unknown> = {},
  ) => {
    const { oauthError, oauthErrorDescription } = parseOAuthError(body);
    state.lastOutcome = {
      at: new Date().toISOString(),
      durationMs,
      grantType,
      ...(oauthError ? { oauthError } : {}),
      result: 'rejected',
      status,
    };
    options.logger?.warn(
      {
        ...logFields,
        ...extra,
        durationMs,
        grantType,
        oauthError,
        oauthErrorDescription,
        status,
      },
      'MCP OAuth token request rejected',
    );
    return oauthError;
  };

  return async (input, init) => {
    const params = init?.body instanceof URLSearchParams ? init.body : null;
    const grantType = params?.get('grant_type');
    if (!init || !params || !grantType) return next(input, init);

    const refreshToken =
      grantType === 'refresh_token' ? params.get('refresh_token') : null;
    if (!refreshToken) {
      const { body, durationMs, response } = await send(input, init, grantType);
      if (response.ok) {
        state.lastOutcome = {
          at: new Date().toISOString(),
          durationMs,
          grantType,
          result: 'success',
          status: response.status,
        };
        options.logger?.info(
          { ...logFields, durationMs, grantType, status: response.status },
          'MCP OAuth token request succeeded',
        );
      } else {
        recordRejection(grantType, response.status, body, durationMs);
      }
      return cloneResponse(response, body);
    }

    return state.exclusive(async () => {
      const refreshTokenFingerprint = fingerprint(refreshToken);
      const replayed = state.replay(refreshToken);
      if (replayed) {
        state.lastOutcome = {
          at: new Date().toISOString(),
          grantType,
          result: 'replayed',
          status: replayed.status,
        };
        options.logger?.info(
          { ...logFields, refreshTokenFingerprint },
          'MCP OAuth refresh joined a concurrent refresh',
        );
        return replayed;
      }

      const snapshot = await options.store.tokens(options.serverName);
      const { body, durationMs, response } = await send(input, init, grantType);
      if (!response.ok) {
        const storedRefreshToken = (
          await options.store.tokens(options.serverName)
        )?.refresh_token;
        const oauthError = recordRejection(
          grantType,
          response.status,
          body,
          durationMs,
          {
            refreshTokenFingerprint,
            storedRefreshTokenFingerprint: storedRefreshToken
              ? fingerprint(storedRefreshToken)
              : undefined,
          },
        );
        if (oauthError && REFRESH_TOKEN_REJECTIONS.has(oauthError)) {
          state.markRejected(refreshToken);
        }
        return cloneResponse(response, body);
      }

      const tokens = parseTokenResponse(parseJson(body));
      let persistence: RefreshedTokenPersistence | 'invalid_response' =
        'invalid_response';
      const rotated = Boolean(
        tokens?.refresh_token && tokens.refresh_token !== refreshToken,
      );
      if (tokens) {
        persistence = await options.store
          .replaceRefreshedTokens(
            options.serverName,
            refreshToken,
            tokens,
            snapshot?.refresh_token === refreshToken
              ? snapshot.access_token
              : undefined,
          )
          .catch((error: unknown) => {
            options.logger?.error(
              { ...logFields, error, refreshTokenFingerprint },
              'MCP OAuth refreshed tokens could not be persisted',
            );
            throw error;
          });
        if (persistence === 'superseded') {
          // The stored set was removed or replaced while this request was in
          // flight; keep the SDK from writing the stale response over it.
          state.markSuperseded(tokens.access_token);
        } else if (rotated) {
          state.remember(refreshToken, response, body);
        }
      }
      state.lastOutcome = {
        at: new Date().toISOString(),
        durationMs,
        grantType,
        result: 'success',
        status: response.status,
      };
      options.logger?.info(
        {
          ...logFields,
          durationMs,
          expiresIn: tokens?.expires_in,
          nextRefreshTokenFingerprint:
            rotated && tokens?.refresh_token
              ? fingerprint(tokens.refresh_token)
              : undefined,
          persistence,
          refreshTokenFingerprint,
          rotated,
          status: response.status,
        },
        'MCP OAuth token refresh succeeded',
      );
      return cloneResponse(response, body);
    });
  };
}

/** Short, non-reversible identifier for correlating token rotation in logs. */
export function fingerprint(token: string): string {
  return hashToken(token).slice(0, 12);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cloneResponse(response: Response, body: string): Response {
  const nullBody = [101, 204, 205, 304].includes(response.status);
  return new Response(nullBody ? null : body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function parseOAuthError(body: string): {
  oauthError?: string;
  oauthErrorDescription?: string;
} {
  const parsed = parseJson(body);
  if (typeof parsed !== 'object' || parsed === null) return {};
  const error = Reflect.get(parsed, 'error');
  const description = Reflect.get(parsed, 'error_description');
  return {
    ...(typeof error === 'string' ? { oauthError: error.slice(0, 64) } : {}),
    ...(typeof description === 'string'
      ? {
          oauthErrorDescription: description.slice(
            0,
            MAX_ERROR_DESCRIPTION_LENGTH,
          ),
        }
      : {}),
  };
}
