import * as oauth from 'oauth4webapi';

export interface MachineTokenClient {
  getToken(): Promise<string>;
  invalidate(): void;
  close(): void;
}

export interface MachineTokenClientOptions {
  clientId: string;
  privateKey: CryptoKey;
  keyId: string;
  tokenEndpoint: string;
  resource: string;
  fetch?: typeof globalThis.fetch;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const REFRESH_SAFETY_MS = 60_000;
const remapEd25519: oauth.ModifyAssertionOptions = {
  [oauth.modifyAssertion]: (header) => {
    if (header.alg === 'Ed25519') header.alg = 'EdDSA';
  },
};

export function createMachineTokenClient(
  options: MachineTokenClientOptions,
): MachineTokenClient {
  let cached: CachedToken | undefined;
  let inflight: Promise<CachedToken> | undefined;
  let requestController: AbortController | undefined;
  let closed = false;

  const request = async (controller: AbortController): Promise<CachedToken> => {
    const endpoint = new URL(options.tokenEndpoint);
    const server: oauth.AuthorizationServer = {
      issuer: `${endpoint.origin}/api/auth`,
      token_endpoint: endpoint.href,
    };
    const client: oauth.Client = {
      client_id: options.clientId,
      token_endpoint_auth_method: 'private_key_jwt',
    };
    const auth = oauth.PrivateKeyJwt(
      { key: options.privateKey, kid: options.keyId },
      remapEd25519,
    );
    const parameters = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'machine:connect',
      resource: options.resource,
    });
    const response = await oauth.clientCredentialsGrantRequest(
      server,
      client,
      auth,
      parameters,
      {
        [oauth.customFetch]: (input, init) =>
          (options.fetch ?? globalThis.fetch)(input, {
            ...init,
            signal: controller.signal,
          }),
      },
    );
    const result = await oauth.processClientCredentialsResponse(
      server,
      client,
      response,
    );
    return {
      value: result.access_token,
      expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000,
    };
  };

  return {
    async getToken() {
      if (closed) throw new Error('Machine token client is closed');
      if (cached && cached.expiresAt > Date.now() + REFRESH_SAFETY_MS) {
        return cached.value;
      }
      if (!inflight) {
        requestController = new AbortController();
        inflight = request(requestController).finally(() => {
          inflight = undefined;
          requestController = undefined;
        });
      }
      cached = await inflight;
      return cached.value;
    },
    invalidate() {
      cached = undefined;
    },
    close() {
      closed = true;
      cached = undefined;
      requestController?.abort(new Error('Machine token client is closed'));
    },
  };
}
