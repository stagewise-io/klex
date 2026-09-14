import { describe, expect, it, vi } from 'vitest';

import { generateMachineIdentity } from '../src/cloud/identity.js';
import { createMachineTokenClient } from '../src/cloud/token-client.js';

describe('machine token client', () => {
  it('caches valid tokens and refreshes short-lived tokens', async () => {
    const identity = await generateMachineIdentity();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'first-token',
          token_type: 'Bearer',
          expires_in: 30,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'second-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
    const client = createMachineTokenClient({
      clientId: 'machine-1',
      privateKey: identity.privateKey,
      keyId: identity.privateKeyKid,
      tokenEndpoint: 'https://cloud.example/api/auth/oauth2/token',
      resource: 'https://cloud.example/machine-connections',
      fetch,
    });

    await expect(client.getToken()).resolves.toBe('first-token');
    await expect(client.getToken()).resolves.toBe('second-token');
    await expect(client.getToken()).resolves.toBe('second-token');
    expect(fetch).toHaveBeenCalledTimes(2);
    const request = fetch.mock.calls[0]?.[1];
    expect(String(request?.body)).toContain('scope=machine%3Aconnect');
    expect(String(request?.body)).toContain('client_assertion=');
  });

  it('invalidates and closes without exposing credentials in errors', async () => {
    const identity = await generateMachineIdentity();
    const client = createMachineTokenClient({
      clientId: 'machine-1',
      privateKey: identity.privateKey,
      keyId: identity.privateKeyKid,
      tokenEndpoint: 'https://cloud.example/api/auth/oauth2/token',
      resource: 'https://cloud.example/machine-connections',
      fetch: async () =>
        Response.json(
          { error: 'invalid_client', error_description: 'rejected' },
          { status: 401 },
        ),
    });
    await expect(client.getToken()).rejects.toThrow(
      'server responded with an error',
    );
    client.invalidate();
    client.close();
    await expect(client.getToken()).rejects.toThrow('closed');
  });
});
