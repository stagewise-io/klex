import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { createMachineAuthenticator } from '../src/cloud/auth.js';
import { createPrincipalMcpRouter } from '../src/cloud/principal-router.js';
import type { MachineMcp } from '../src/mcp.js';

async function token(
  privateKey: CryptoKey,
  claims: Record<string, unknown> = {},
) {
  return new SignJWT({ scope: 'mcp:use', client_id: 'agent-1', ...claims })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('https://cloud.example/api/auth')
    .setAudience('https://proxy.example/machines/machine-1/mcp')
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('machine authentication', () => {
  it('validates issuer, audience, scope, and principal identity', async () => {
    const { privateKey, publicKey } = await generateKeyPair('Ed25519');
    const authenticator = createMachineAuthenticator({
      issuer: 'https://cloud.example/api/auth',
      audience: 'https://proxy.example/machines/machine-1/mcp',
      jwksUrl: 'https://cloud.example/api/auth/jwks',
      protectedResourceMetadataUrl:
        'https://cloud.example/.well-known/oauth-protected-resource/machines/machine-1',
      keyResolver: async () => publicKey,
    });
    await expect(
      authenticator.authenticate(
        new Request('https://machine/mcp', {
          headers: { authorization: `Bearer ${await token(privateKey)}` },
        }),
      ),
    ).resolves.toBe('agent-1');
    await expect(
      authenticator.authenticate(
        new Request('https://machine/mcp', {
          headers: {
            authorization: `Bearer ${await token(privateKey, { scope: 'other' })}`,
          },
        }),
      ),
    ).rejects.toThrow('scope');
    expect(authenticator.challenge()).toBe(
      'Bearer resource_metadata="https://cloud.example/.well-known/oauth-protected-resource/machines/machine-1" scope="mcp:use"',
    );
  });

  it('isolates MCP instances by principal and closes every instance', async () => {
    const close = vi.fn(async () => undefined);
    const instances: MachineMcp[] = [];
    const router = createPrincipalMcpRouter(
      {
        authenticate: async (request) => request.headers.get('x-agent') ?? '',
        challenge: () => 'Bearer resource_metadata="https://cloud/resource"',
      },
      '/tmp',
      () => {
        const instance: MachineMcp = {
          fetch: async () => new Response(String(instances.length)),
          close,
        };
        instances.push(instance);
        return instance;
      },
    );
    await expect(
      (await router.fetch(new Request('https://machine/mcp'))).status,
    ).toBe(200);
    await router.fetch(
      new Request('https://machine/mcp', { headers: { 'x-agent': 'agent-2' } }),
    );
    await router.close();
    expect(instances).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(2);
    await expect(
      (await router.fetch(new Request('https://machine/mcp'))).status,
    ).toBe(503);
  });
});
