export interface ProtectedResourceConfiguration {
  issuer: string;
  resource: string;
}

export async function loadProtectedResourceConfiguration(
  metadataUrl: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProtectedResourceConfiguration> {
  const response = await fetchImplementation(metadataUrl, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `Protected resource metadata request failed (${response.status})`,
    );
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') {
    throw new Error('Protected resource metadata is invalid');
  }
  const metadata = value as Record<string, unknown>;
  const servers = metadata.authorization_servers;
  if (
    typeof metadata.resource !== 'string' ||
    !Array.isArray(servers) ||
    typeof servers[0] !== 'string'
  ) {
    throw new Error('Protected resource metadata is invalid');
  }
  return {
    issuer: servers[0],
    resource: metadata.resource,
  };
}
