import type { CloudConnectivity } from '@/cloud-connectivity';

interface TrustedProtectedResource {
  resource: string;
  scopes: string[];
}

function parseQuotedParameter(
  challenge: string,
  parameter: string,
): string | undefined {
  const expression = new RegExp(
    `(?:^|[\\s,])${parameter}="((?:\\\\.|[^"\\\\])*)"`,
    'i',
  );
  const match = expression.exec(challenge);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\\(.)/g, '$1');
}

function findBearerChallenge(header: string): string | undefined {
  const bearer = /(?:^|,)\s*Bearer(?=\s|,|$)/i.exec(header);
  if (!bearer) return undefined;

  const bearerOffset = bearer[0].search(/Bearer/i);
  const challenge = header.slice(bearer.index + bearerOffset);
  const nextChallenge =
    /,\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?!\s*=)(?=\s|,|$)/.exec(
      challenge.slice('Bearer'.length),
    );
  return nextChallenge
    ? challenge.slice(0, 'Bearer'.length + nextChallenge.index)
    : challenge;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isSameResourceRequest(requestUrl: string, resource: string): boolean {
  const requested = new URL(requestUrl);
  const canonical = new URL(resource);
  return (
    requested.origin === canonical.origin &&
    requested.pathname === canonical.pathname &&
    requested.search === canonical.search &&
    requested.username === '' &&
    requested.password === ''
  );
}

function resolveSafeMetadataUrl(
  metadataUrl: string,
  configuredResource: string,
): URL | null {
  try {
    const metadata = new URL(metadataUrl);
    const resource = new URL(configuredResource);
    if (
      metadata.origin !== resource.origin ||
      !['http:', 'https:'].includes(metadata.protocol) ||
      metadata.username !== '' ||
      metadata.password !== ''
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

async function discoverTrustedResource(
  response: Response,
  configuredResource: string,
  cloudConnectivity: CloudConnectivity,
  fetchImpl: typeof fetch,
): Promise<TrustedProtectedResource | null> {
  const header = response.headers.get('www-authenticate');
  if (!header) return null;
  const challenge = findBearerChallenge(header);
  if (!challenge) return null;

  const metadataUrlValue = parseQuotedParameter(challenge, 'resource_metadata');
  if (!metadataUrlValue) return null;
  const metadataUrl = resolveSafeMetadataUrl(
    metadataUrlValue,
    configuredResource,
  );
  if (!metadataUrl) return null;
  const scopeValue = parseQuotedParameter(challenge, 'scope');
  const scopes = scopeValue?.split(/\s+/).filter(Boolean) ?? [];

  let metadataResponse: Response;
  try {
    metadataResponse = await fetchImpl(metadataUrl, { redirect: 'error' });
  } catch {
    return null;
  }
  if (!metadataResponse.ok) return null;

  const metadata: unknown = await metadataResponse.json().catch(() => null);
  if (typeof metadata !== 'object' || metadata === null) return null;
  const resource = Reflect.get(metadata, 'resource');
  const authorizationServers = Reflect.get(metadata, 'authorization_servers');
  const supportedScopes = Reflect.get(metadata, 'scopes_supported');
  if (!isStringArray(authorizationServers)) return null;
  const trustedIssuers = authorizationServers.filter((issuer) =>
    cloudConnectivity.isTrustedAuthorizationServer(issuer),
  );
  if (trustedIssuers.length === 0) return null;
  if (trustedIssuers.length !== 1 || authorizationServers.length !== 1) {
    throw new Error('Cloud MCP metadata has conflicting authorization servers');
  }
  if (typeof resource !== 'string' || !isStringArray(supportedScopes)) {
    throw new Error('Cloud MCP metadata is malformed');
  }
  if (resource !== configuredResource) {
    throw new Error(
      'Cloud MCP metadata resource does not match the configured URL',
    );
  }
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !supportedScopes.includes(scope))
  ) {
    throw new Error('Cloud MCP metadata does not support the required scope');
  }

  return { resource, scopes };
}

export function createDiscoveryAuthenticatedFetch(
  cloudConnectivity: CloudConnectivity,
  configuredResource: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  let trustedResource: TrustedProtectedResource | null = null;
  let discovery: Promise<TrustedProtectedResource | null> | null = null;

  const discover = (response: Response) => {
    discovery ??= discoverTrustedResource(
      response,
      configuredResource,
      cloudConnectivity,
      fetchImpl,
    ).finally(() => {
      discovery = null;
    });
    return discovery;
  };

  return async (input, init) => {
    const request = new Request(input, init);

    const performAuthenticated = async (
      protectedResource: TrustedProtectedResource,
      refresh: boolean,
    ): Promise<Response> => {
      if (!isSameResourceRequest(request.url, protectedResource.resource)) {
        throw new Error(
          'Refusing to send a Cloud token to a different resource',
        );
      }
      if (refresh) {
        cloudConnectivity.invalidateAccessToken(protectedResource.resource);
      }
      const token = await cloudConnectivity.getAccessToken(
        protectedResource.resource,
        protectedResource.scopes,
      );
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetchImpl(
        new Request(request.clone(), { headers, redirect: 'manual' }),
      );
    };

    if (trustedResource) {
      const response = await performAuthenticated(trustedResource, false);
      if (response.status !== 401) return response;
      return performAuthenticated(trustedResource, true);
    }

    const response = await fetchImpl(request.clone());
    if (response.status !== 401) return response;
    const discovered = await discover(response);
    if (!discovered) return response;
    trustedResource = discovered;
    return performAuthenticated(discovered, false);
  };
}
