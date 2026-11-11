import { asSchema, type ToolSet } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Mcp } from '@/mcp';
import type { ExtensionDeps } from '@/session/chat/extensions/extension-api';
import { createMcpToolsExt } from '@/session/chat/extensions/mcp-tools';

import { builtInProviderDefinitions } from './providers';

const extension = createMcpToolsExt.create({
  mcp: {} as Mcp,
  sessionId: 'adapter-contract',
} as ExtensionDeps);
const tools = extension.getTools!({} as never) as ToolSet;

afterEach(() => vi.unstubAllGlobals());

describe('MCP gateway provider wire contracts (no live inference)', () => {
  for (const definition of builtInProviderDefinitions.filter(
    (candidate) => candidate.createLanguageModel,
  )) {
    it(`serializes generic runTool params through ${definition.type}`, async () => {
      const bodies: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          bodies.push(String(init?.body ?? ''));
          return new Response('{}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      const model = definition.createLanguageModel!(
        {
          id: 'contract',
          type: definition.type,
          settings: {
            apiKey: 'synthetic',
            baseUrl: 'https://provider.invalid/v1',
            resourceName: 'synthetic',
            project: 'synthetic',
            location: 'us-central1',
            authMode:
              definition.type === 'chatgpt-codex-subscription'
                ? 'managed'
                : 'api-key',
            region: 'us-east-1',
          },
        },
        'test-model',
        {
          credential: async () => ({
            accessToken: 'synthetic',
            refreshToken: 'synthetic',
          }),
          invalidate: async () => undefined,
        },
      );
      const declarations = await Promise.all(
        Object.entries(tools).map(async ([name, tool]) => ({
          type: 'function' as const,
          name,
          description:
            typeof tool.description === 'string' ? tool.description : undefined,
          inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        })),
      );
      await Promise.resolve(
        model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
          tools: declarations,
        }),
      ).catch(() => undefined);
      expect(bodies).toHaveLength(1);
      const body = JSON.parse(bodies[0]!);
      const serialized = JSON.stringify(body);
      for (const name of ['runTool', 'listTools', 'getToolInfo'])
        expect(serialized).toContain(name);
      expect(serialized).toContain('params');
      const findParams = (value: unknown): Record<string, unknown>[] => {
        if (!value || typeof value !== 'object') return [];
        const record = value as Record<string, unknown>;
        return [
          ...(record.params && typeof record.params === 'object'
            ? [record.params as Record<string, unknown>]
            : []),
          ...Object.values(record).flatMap(findParams),
        ];
      };
      const paramsSchemas = findParams(body);
      expect(paramsSchemas.length).toBeGreaterThan(0);
      for (const schema of paramsSchemas) {
        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).not.toBe(false);
      }
      expect(serialized).not.toContain('runInSandbox');
    });
  }
});
