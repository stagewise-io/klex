// Codex ChatGPT device-code sign-in, reimplemented over HTTPS so no Codex
// executable is needed. Mirrors codex-rs/login/src/device_code_auth.rs (start
// and poll), server.rs `exchange_code_for_tokens` (form-encoded code exchange)
// and auth/manager.rs `request_chatgpt_token_refresh` (JSON refresh).
//
// Codes, URLs and tokens are bearer capabilities: never put them in errors or
// logs.

import type {
  DeviceAuthorizationChallenge,
  DeviceAuthorizationPollResult,
  ProviderCredential,
  ProviderOperationResult,
} from '../provider-registry';
import { available, isRecord, sanitizedError, unavailable } from './shared';

export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const API_BASE = `${CODEX_ISSUER}/api/accounts`;
const USER_CODE_URL = `${API_BASE}/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${API_BASE}/deviceauth/token`;
const VERIFICATION_URI = `${CODEX_ISSUER}/codex/device`;
const REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
const TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
/** Codex waits at most 15 minutes for approval. */
const DEVICE_CODE_LIFETIME_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 5_000;
const ACCOUNT_CLAIMS = 'https://api.openai.com/auth';
const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);

export interface CodexDeviceHandle {
  deviceAuthId: string;
  userCode: string;
}

export function isCodexDeviceHandle(
  value: unknown,
): value is CodexDeviceHandle {
  return (
    isRecord(value) &&
    typeof value.deviceAuthId === 'string' &&
    typeof value.userCode === 'string'
  );
}

export async function startDeviceAuthorization(
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<ProviderOperationResult<DeviceAuthorizationChallenge>> {
  let response: Response;
  try {
    response = await fetch(USER_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      signal,
    });
  } catch (error) {
    return transportFailure(error, signal);
  }
  if (response.status === 404)
    return unavailable(
      'unsupported_operation',
      'Device code sign-in is not enabled for this ChatGPT account service',
    );
  if (!response.ok)
    return unavailable(
      'connectivity_failed',
      `Codex device code request failed with status ${response.status}`,
    );
  const body = await readJson(response);
  const deviceAuthId = body?.device_auth_id;
  const userCode = body?.user_code ?? body?.usercode;
  if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string')
    return unavailable(
      'connectivity_failed',
      'Codex device code response is invalid',
    );
  return available({
    verificationUri: VERIFICATION_URI,
    userCode,
    expiresAt: new Date(now() + DEVICE_CODE_LIFETIME_MS).toISOString(),
    intervalMs: parseInterval(body?.interval),
    handle: { deviceAuthId, userCode } satisfies CodexDeviceHandle,
  });
}

export async function pollDeviceAuthorization(
  handle: unknown,
  signal: AbortSignal,
): Promise<ProviderOperationResult<DeviceAuthorizationPollResult>> {
  if (!isCodexDeviceHandle(handle))
    return unavailable('internal_error', 'Invalid Codex device handle');
  let response: Response;
  try {
    response = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: handle.deviceAuthId,
        user_code: handle.userCode,
      }),
      signal,
    });
  } catch (error) {
    return transportFailure(error, signal);
  }
  // Codex treats both as "user has not approved yet".
  if (response.status === 403 || response.status === 404)
    return available({ status: 'pending' });
  if (response.status >= 500 || response.status === 429)
    return unavailable(
      'connectivity_failed',
      `Codex device sign-in poll failed with status ${response.status}`,
    );
  if (!response.ok)
    return unavailable(
      'authentication_required',
      `Codex device sign-in failed with status ${response.status}`,
      'Start the sign-in again.',
    );
  const body = await readJson(response);
  const code = body?.authorization_code;
  const verifier = body?.code_verifier;
  if (typeof code !== 'string' || typeof verifier !== 'string')
    return unavailable(
      'authentication_required',
      'Codex device sign-in returned an invalid response',
      'Start the sign-in again.',
    );
  const exchanged = await exchangeCode(code, verifier, signal);
  if (!exchanged.ok) return exchanged;
  return available({ status: 'authorized', credential: exchanged.value });
}

/**
 * The authorization code is single use and was already consumed from the
 * device endpoint, so every exchange failure is permanent for this attempt.
 * Codex likewise never retries a code POST that may have reached the server.
 */
async function exchangeCode(
  code: string,
  codeVerifier: string,
  signal: AbortSignal,
): Promise<ProviderOperationResult<ProviderCredential>> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CODEX_CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }).toString(),
      signal,
    });
  } catch {
    return unavailable(
      'authentication_required',
      'Codex token exchange could not be completed',
      'Start the sign-in again.',
    );
  }
  const body = response.ok ? await readJson(response) : undefined;
  const credential = body && credentialFromTokens(body);
  if (!credential)
    return unavailable(
      'authentication_required',
      response.ok
        ? 'Codex token exchange returned an invalid response'
        : `Codex token exchange failed with status ${response.status}`,
      'Start the sign-in again.',
    );
  return available(credential);
}

export async function refreshCredential(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderOperationResult<ProviderCredential>> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
      }),
      signal,
    });
  } catch (error) {
    return transportFailure(error, signal);
  }
  if (!response.ok) {
    const code = oauthErrorCode(await readJson(response));
    const permanent =
      response.status === 401 ||
      (code !== undefined && PERMANENT_REFRESH_CODES.has(code)) ||
      (response.status === 400 && code === 'invalid_grant');
    return permanent
      ? unavailable(
          'authentication_required',
          'The ChatGPT sign-in has expired or was revoked',
          'Sign in again.',
        )
      : unavailable(
          'connectivity_failed',
          `Codex token refresh failed with status ${response.status}`,
        );
  }
  const body = await readJson(response);
  const accessToken = body?.access_token;
  if (typeof accessToken !== 'string' || !accessToken)
    return unavailable(
      'connectivity_failed',
      'Codex token refresh returned an invalid response',
    );
  // Refresh responses may omit tokens that did not rotate.
  const idToken =
    typeof body?.id_token === 'string' ? body.id_token : credential.idToken;
  const refreshToken =
    typeof body?.refresh_token === 'string' && body.refresh_token
      ? body.refresh_token
      : credential.refreshToken;
  return available(
    buildCredential(accessToken, refreshToken, idToken, credential.accountId),
  );
}

function credentialFromTokens(
  body: Record<string, unknown>,
): ProviderCredential | undefined {
  const { access_token, refresh_token, id_token } = body;
  if (
    typeof access_token !== 'string' ||
    !access_token ||
    typeof refresh_token !== 'string' ||
    !refresh_token
  )
    return undefined;
  return buildCredential(
    access_token,
    refresh_token,
    typeof id_token === 'string' ? id_token : undefined,
  );
}

function buildCredential(
  accessToken: string,
  refreshToken: string,
  idToken: string | undefined,
  previousAccountId?: string,
): ProviderCredential {
  const expiresAt = jwtExpiration(accessToken);
  const accountId =
    codexAccountId(accessToken) ??
    (idToken && codexAccountId(idToken)) ??
    previousAccountId;
  return {
    accessToken,
    refreshToken,
    ...(idToken && { idToken }),
    ...(expiresAt !== undefined && {
      expiresAt: new Date(expiresAt).toISOString(),
    }),
    ...(accountId && { accountId }),
  };
}

/** Error code from `error`, `error.code` or top-level `code`, as Codex reads it. */
function oauthErrorCode(
  body: Record<string, unknown> | undefined,
): string | undefined {
  if (!body) return undefined;
  const { error, code } = body;
  const value =
    typeof error === 'string'
      ? error
      : isRecord(error) && typeof error.code === 'string'
        ? error.code
        : typeof code === 'string'
          ? code
          : undefined;
  return value?.toLowerCase();
}

function parseInterval(value: unknown): number {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : DEFAULT_INTERVAL_MS;
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = (await response.json()) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function transportFailure(
  error: unknown,
  signal: AbortSignal,
): ProviderOperationResult<never> {
  return unavailable(
    'connectivity_failed',
    signal.aborted
      ? sanitizedError(error)
      : 'Could not reach the ChatGPT account service',
  );
}

/** ChatGPT account id from the `https://api.openai.com/auth` claim object. */
export function codexAccountId(token: string): string | undefined {
  const claims = jwtClaim(token, ACCOUNT_CLAIMS);
  if (isRecord(claims) && typeof claims.chatgpt_account_id === 'string')
    return claims.chatgpt_account_id || undefined;
  return jwtStringClaim(token, `${ACCOUNT_CLAIMS}.chatgpt_account_id`);
}

export function jwtExpiration(token: string): number | undefined {
  const value = jwtClaim(token, 'exp');
  return typeof value === 'number' ? value * 1_000 : undefined;
}

export function jwtStringClaim(
  token: string,
  claim: string,
): string | undefined {
  const value = jwtClaim(token, claim);
  return typeof value === 'string' ? value : undefined;
}

function jwtClaim(token: string, claim: string): unknown {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as unknown;
    return isRecord(parsed) ? parsed[claim] : undefined;
  } catch {
    return undefined;
  }
}
