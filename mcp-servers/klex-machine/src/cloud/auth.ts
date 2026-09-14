import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

export interface MachineAuthenticator {
  authenticate(request: Request): Promise<string>;
  challenge(): string;
}

export interface MachineAuthenticatorOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  protectedResourceMetadataUrl: string;
  keyResolver?: JWTVerifyGetKey;
}

export function createMachineAuthenticator(
  options: MachineAuthenticatorOptions,
): MachineAuthenticator {
  const keyResolver =
    options.keyResolver ?? createRemoteJWKSet(new URL(options.jwksUrl));
  return {
    async authenticate(request) {
      const authorization = request.headers.get('authorization');
      const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
      if (!match?.[1]) throw new Error('Missing bearer token');
      const { payload } = await jwtVerify(match[1], keyResolver, {
        issuer: options.issuer,
        audience: options.audience,
      });
      const scope =
        typeof payload.scope === 'string'
          ? payload.scope.split(/\s+/)
          : Array.isArray(payload.scope)
            ? payload.scope
            : [];
      if (!scope.includes('mcp:use')) throw new Error('Missing mcp:use scope');
      if (typeof payload.client_id !== 'string' || !payload.client_id.trim()) {
        throw new Error('Missing client_id claim');
      }
      return payload.client_id;
    },
    challenge() {
      return `Bearer resource_metadata="${options.protectedResourceMetadataUrl}"`;
    },
  };
}
