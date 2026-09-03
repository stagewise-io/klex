import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectMcpServer } from './connection';
import { LocalOAuthAuthorizationCoordinator } from './oauth/coordinator';
import { LocalOAuthCallbackReceiver } from './oauth/local-callback';
import { McpOAuthStore } from './oauth/store';

const temporaryDirectories: string[] = [];

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonRequest(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(parsed)) throw new Error('Expected a JSON object');
  return parsed;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('connectMcpServer OAuth lifecycle', () => {
  it('reauthorizes against a local server and reconnects with a fresh transport', async () => {
    let origin = '';
    const requests: string[] = [];
    let unauthorizedRequests = 0;
    let authorizedRequests = 0;
    let tokenExchanges = 0;
    const authorizationStatuses: string[] = [];
    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? '/', origin);
      requests.push(`${request.method} ${requestUrl.pathname}`);
      if (requestUrl.pathname === '/.well-known/oauth-protected-resource/mcp') {
        sendJson(response, 200, {
          authorization_servers: [origin],
          resource: `${origin}/mcp`,
        });
        return;
      }
      if (requestUrl.pathname === '/.well-known/oauth-authorization-server') {
        sendJson(response, 200, {
          authorization_endpoint: `${origin}/authorize`,
          code_challenge_methods_supported: ['S256'],
          issuer: origin,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          token_endpoint: `${origin}/token`,
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (requestUrl.pathname === '/register') {
        const metadata = await readJsonRequest(request);
        sendJson(response, 201, {
          ...metadata,
          client_id: 'local-test-client',
          token_endpoint_auth_method: 'none',
        });
        return;
      }
      if (requestUrl.pathname === '/token') {
        tokenExchanges += 1;
        sendJson(response, 200, {
          access_token: 'local-test-token',
          expires_in: 3600,
          token_type: 'Bearer',
        });
        return;
      }
      if (requestUrl.pathname === '/mcp') {
        if (request.headers.authorization !== 'Bearer local-test-token') {
          unauthorizedRequests += 1;
          response.writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
          response.end();
          return;
        }
        authorizedRequests += 1;
        if (request.method === 'POST') {
          const message = await readJsonRequest(request);
          if (message.method === 'initialize') {
            sendJson(response, 200, {
              id: message.id,
              jsonrpc: '2.0',
              result: {
                capabilities: {},
                protocolVersion: '2025-11-25',
                serverInfo: { name: 'oauth-fixture', version: '1.0.0' },
              },
            });
            return;
          }
        }
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected an IP server address');
    }
    origin = `http://127.0.0.1:${address.port}`;

    const configDirectory = await mkdtemp(join(tmpdir(), 'klex-oauth-e2e-'));
    temporaryDirectories.push(configDirectory);
    const store = new McpOAuthStore(join(configDirectory, 'mcp-oauth.json'));
    const coordinator = new LocalOAuthAuthorizationCoordinator(
      async (authorizationUrl) => {
        const redirectUrl = authorizationUrl.searchParams.get('redirect_uri');
        const state = authorizationUrl.searchParams.get('state');
        if (redirectUrl === null || state === null) {
          throw new Error('Authorization URL omitted callback parameters');
        }
        const callbackUrl = new URL(redirectUrl);
        callbackUrl.searchParams.set('code', 'approved-code');
        callbackUrl.searchParams.set('state', state);
        await fetch(callbackUrl);
      },
    );

    try {
      const connection = await connectMcpServer({
        config: {
          url: `${origin}/mcp`,
          versionNegotiation: 'legacy',
        },
        namespace: 'oauth-fixture',
        onDisconnect: () => undefined,
        onPushNotification: () => undefined,
        onRealtimeMediaNotification: () => undefined,
        onToolsChanged: () => undefined,
        onAuthorizationStatus: (status) => authorizationStatuses.push(status),
        oauth: {
          sessionFactory: {
            start: async () => {
              const receiver = await LocalOAuthCallbackReceiver.start();
              return {
                authorize: (options) =>
                  coordinator.authorize({ ...options, receiver }),
                close: () => receiver.close(),
                redirectUrl: receiver.redirectUrl,
              };
            },
          },
          store,
        },
        signal: new AbortController().signal,
      });

      expect(authorizationStatuses).toEqual(['authorizing', 'connecting']);
      expect(unauthorizedRequests).toBeGreaterThan(0);
      expect(authorizedRequests).toBeGreaterThan(0);
      expect(tokenExchanges).toBe(1);
      expect(requests).toContain('POST /token');
      await connection.close();
    } finally {
      await coordinator.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
