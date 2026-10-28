import { createServer } from 'node:http';

import type {
  Implementation,
  ServerCapabilities,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { connectMcpServer } from './connection';

const serverInfo: Implementation = {
  name: 'advertised-server',
  title: 'Example connector',
  version: '1.2.3',
  description: 'Search and manage example records.',
  websiteUrl: 'https://example.com',
  icons: [
    {
      src: 'https://example.com/light.svg',
      mimeType: 'image/svg+xml',
      sizes: ['any'],
      theme: 'light',
    },
    {
      src: 'data:image/png;base64,aGVsbG8=',
      mimeType: 'image/png',
      sizes: ['32x32'],
      theme: 'dark',
    },
  ],
};
const capabilities: ServerCapabilities = {
  tools: { listChanged: false },
  resources: { subscribe: true, listChanged: false },
  prompts: { listChanged: false },
  logging: {},
  completions: {},
  tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
  experimental: { 'example.com/preview': { enabled: true } },
  extensions: {
    'example.com/custom': {
      modes: ['a', 'b'],
      nested: { limit: 3, fallback: null },
    },
  },
};

// Exercise the actual pinned SDK and HTTP transport, not mocked accessors.
describe('MCP connection metadata', () => {
  it.each(['legacy', 'modern'] as const)(
    'reads %s metadata without enrichment or requests on access',
    async (era) => {
      const methods: string[] = [];
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const message: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        if (
          typeof message !== 'object' ||
          message === null ||
          !('method' in message)
        ) {
          response.writeHead(400).end();
          return;
        }
        methods.push(String(message.method));
        if (!('id' in message)) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (message.method === 'initialize') {
          result = {
            serverInfo,
            capabilities,
            instructions: '',
            protocolVersion: '2025-11-25',
          };
        } else if (message.method === 'server/discover') {
          result = {
            serverInfo,
            capabilities,
            instructions: '',
            supportedVersions: ['2026-07-28', '2025-11-25'],
          };
        } else if (message.method === 'tools/list') {
          result = {
            tools: [],
            ...(era === 'modern'
              ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
              : {}),
          };
        } else {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected an IP address');
      const connection = await connectMcpServer({
        namespace: 'configured-namespace',
        config: {
          url: `http://127.0.0.1:${address.port}/mcp`,
          versionNegotiation:
            era === 'legacy' ? 'legacy' : { pin: '2026-07-28' },
        },
        signal: AbortSignal.timeout(5_000),
        onToolsChanged: () => undefined,
        onDisconnect: () => undefined,
        onPushNotification: () => undefined,
        onRealtimeMediaNotification: () => undefined,
        onResourceUpdated: () => undefined,
      }).catch(async (error) => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      });
      try {
        const requestCount = methods.length;
        expect(connection.namespace).toBe('configured-namespace');
        // The pinned SDK drops the legacy tasks declaration when decoding
        // modern discovery. Forward its normalized view, not raw wire fields.
        const expectedCapabilities = structuredClone(capabilities);
        if (era === 'modern') delete expectedCapabilities.tasks;
        expect(connection.metadata).toEqual({
          serverInfo,
          capabilities: expectedCapabilities,
          instructions: '',
          protocolVersion: era === 'legacy' ? '2025-11-25' : '2026-07-28',
          protocolEra: era,
          ...(era === 'modern'
            ? { supportedVersions: ['2026-07-28', '2025-11-25'] }
            : {}),
        });
        const snapshot = connection.metadata;
        if (snapshot.serverInfo) snapshot.serverInfo.name = 'mutated';
        if (snapshot.capabilities?.extensions)
          snapshot.capabilities.extensions['example.com/custom'] = {};
        expect(connection.metadata.serverInfo).toEqual(serverInfo);
        expect(connection.metadata.capabilities).toEqual(expectedCapabilities);
        expect(methods).toHaveLength(requestCount);
        expect(methods).not.toContain(
          era === 'legacy' ? 'server/discover' : 'initialize',
        );
      } finally {
        await connection.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
