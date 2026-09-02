import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ExtensionDeps, ExtensionFactory } from '../extension-api';
import { createMcpResourceViewerExt } from './mcp-resource-viewer';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function createMockDeps(
  mcpOverrides: Partial<ExtensionDeps['mcp']> = {},
): ExtensionDeps {
  const mcp = {
    listResources: vi.fn(),
    readResource: vi.fn(),
    ...mcpOverrides,
  } as unknown as ExtensionDeps['mcp'];

  return {
    getHistory: () => [],
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: { get: () => ({}) } as unknown as ExtensionDeps['config'],
    generateText: vi.fn(() =>
      Promise.resolve({
        success: false as const,
        failureReason: 'no-models' as const,
      }),
    ),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ModuleLogger,
    logging: {
      child: () =>
        ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          trace: vi.fn(),
        }) as unknown as ModuleLogger,
    } as unknown as ExtensionDeps['logging'],
    mcp,
    router: { sendInput: vi.fn() } as unknown as ExtensionDeps['router'],
    sessionId: 'test-session-id',
    getDataDir: vi.fn(() => '/tmp/test-mcp-resource-viewer'),
  } as unknown as ExtensionDeps;
}

function getTool(ext: ReturnType<ExtensionFactory['create']>, name: string) {
  const tools = ext.getTools?.({} as never);
  if (!tools) throw new Error('Extension has no getTools');
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

async function callTool(
  ext: ReturnType<ExtensionFactory['create']>,
  name: string,
  input: Record<string, unknown>,
) {
  const tool = getTool(ext, name);
  const execute = ('execute' in tool ? tool.execute : undefined) as unknown as (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  if (!execute) throw new Error(`Tool ${name} has no execute`);
  return execute(input);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Resource Viewer extension', () => {
  it('exposes listResources and openResource tools', () => {
    const deps = createMockDeps();
    const ext = createMcpResourceViewerExt.create(deps);
    const tools = ext.getTools?.({} as never);
    if (!tools) throw new Error('Extension has no getTools');
    expect(tools).toHaveProperty('listResources');
    expect(tools).toHaveProperty('openResource');
  });

  it('onStart logs an info message and resolves', async () => {
    const deps = createMockDeps();
    const ext = createMcpResourceViewerExt.create(deps);
    await ext.onStart?.();
    expect(deps.logger.info).toHaveBeenCalledWith(
      'MCP Resource Viewer extension started',
    );
  });

  // -------------------------------------------------------------------------
  // listResources
  // -------------------------------------------------------------------------

  it('listResources calls mcp.listResources with the server name and returns formatted output', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [
          {
            name: 'config',
            uri: 'file:///config.json',
            mimeType: 'application/json',
            description: 'App config',
          },
        ],
        resourceTemplates: [
          {
            name: 'logs',
            uriTemplate: 'file:///logs/{date}',
            description: 'Log files by date',
          },
        ],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'github',
    });
    expect(deps.mcp.listResources).toHaveBeenCalledWith('github', undefined);
    const text = result.result as string;
    expect(text).toContain('Resources (1):');
    expect(text).toContain('config');
    expect(text).toContain('file:///config.json');
    expect(text).toContain('application/json');
    expect(text).toContain('Resource Templates (1):');
    expect(text).toContain('logs');
    expect(text).toContain('file:///logs/{date}');
  });

  it('listResources passes cursor when provided', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [{ name: 'page2', uri: 'file:///page2' }],
        resourceTemplates: [],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    await callTool(ext, 'listResources', {
      serverName: 'github',
      cursor: 'cursor-abc',
    });
    expect(deps.mcp.listResources).toHaveBeenCalledWith('github', 'cursor-abc');
  });

  it('listResources includes nextCursor in output when present', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [{ name: 'item1', uri: 'file:///item1' }],
        resourceTemplates: [],
        nextCursor: 'next-page-cursor',
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'github',
    });
    const text = result.result as string;
    expect(text).toContain('More resources available');
    expect(text).toContain('"next-page-cursor"');
  });

  it('listResources does not include pagination hint when nextCursor is absent', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [{ name: 'item1', uri: 'file:///item1' }],
        resourceTemplates: [],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'github',
    });
    const text = result.result as string;
    expect(text).not.toContain('More resources available');
  });

  it('listResources returns a "no resources" message when both lists are empty', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [],
        resourceTemplates: [],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'empty-server',
    });
    const text = result.result as string;
    expect(text).toBe(
      "No resources or resource templates available on server 'empty-server'.",
    );
  });

  it('listResources returns an error string when mcp.listResources throws', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockRejectedValue(new Error('server unavailable')),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'github',
    });
    const text = result.result as string;
    expect(text).toContain("Failed to list resources from server 'github'");
    expect(text).toContain('server unavailable');
  });

  it('listResources handles resources-only (no templates)', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [
          { name: 'res1', uri: 'file:///res1' },
          { name: 'res2', uri: 'file:///res2' },
        ],
        resourceTemplates: [],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'srv',
    });
    const text = result.result as string;
    expect(text).toContain('Resources (2):');
    expect(text).not.toContain('Resource Templates');
  });

  it('listResources handles templates-only (no resources)', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [],
        resourceTemplates: [
          {
            name: 'tmpl',
            uriTemplate: 'file:///tmpl/{id}',
          },
        ],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'srv',
    });
    const text = result.result as string;
    expect(text).not.toContain('Resources (');
    expect(text).toContain('Resource Templates (1):');
  });

  it('listResources omits mimeType/description/size when not present on a resource', async () => {
    const deps = createMockDeps({
      listResources: vi.fn().mockResolvedValue({
        resources: [{ name: 'bare', uri: 'file:///bare' }],
        resourceTemplates: [],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'listResources', {
      serverName: 'srv',
    });
    const text = result.result as string;
    expect(text).toContain('name: "bare"');
    expect(text).toContain('uri: "file:///bare"');
    expect(text).not.toContain('mimeType');
    expect(text).not.toContain('description');
    expect(text).not.toContain('size');
  });

  // -------------------------------------------------------------------------
  // openResource
  // -------------------------------------------------------------------------

  it('openResource calls mcp.readResource with server name and URI, returns text content', async () => {
    const deps = createMockDeps({
      readResource: vi.fn().mockResolvedValue({
        contents: [
          {
            uri: 'file:///config.json',
            mimeType: 'application/json',
            text: '{"key": "value"}',
          },
        ],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'openResource', {
      serverName: 'github',
      uri: 'file:///config.json',
    });
    expect(deps.mcp.readResource).toHaveBeenCalledWith(
      'github',
      'file:///config.json',
    );
    const text = result.result as string;
    expect(text).toContain('Text content');
    expect(text).toContain('application/json');
    expect(text).toContain('{"key": "value"}');
  });

  it('openResource handles blob content (reports mimeType + base64)', async () => {
    const deps = createMockDeps({
      readResource: vi.fn().mockResolvedValue({
        contents: [
          {
            uri: 'file:///image.png',
            mimeType: 'image/png',
            blob: 'iVBORw0KGgo=',
          },
        ],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'openResource', {
      serverName: 'github',
      uri: 'file:///image.png',
    });
    const text = result.result as string;
    expect(text).toContain('Blob content');
    expect(text).toContain('image/png');
    expect(text).toContain('base64');
    expect(text).toContain('iVBORw0KGgo=');
  });

  it('openResource handles multiple content items in a single result', async () => {
    const deps = createMockDeps({
      readResource: vi.fn().mockResolvedValue({
        contents: [
          {
            uri: 'file:///part1',
            mimeType: 'text/plain',
            text: 'first part',
          },
          {
            uri: 'file:///part2',
            mimeType: 'text/plain',
            text: 'second part',
          },
        ],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'openResource', {
      serverName: 'github',
      uri: 'file:///multi',
    });
    const text = result.result as string;
    expect(text).toContain('first part');
    expect(text).toContain('second part');
    expect(text).toContain('---');
  });

  it('openResource returns a message when contents array is empty', async () => {
    const deps = createMockDeps({
      readResource: vi.fn().mockResolvedValue({
        contents: [],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'openResource', {
      serverName: 'github',
      uri: 'file:///empty',
    });
    const text = result.result as string;
    expect(text).toBe("Resource 'file:///empty' returned no content.");
  });

  it('openResource truncates text content at 50K chars', async () => {
    const longText = 'a'.repeat(60_000);
    const deps = createMockDeps({
      readResource: vi.fn().mockResolvedValue({
        contents: [
          {
            uri: 'file:///big',
            mimeType: 'text/plain',
            text: longText,
          },
        ],
      }),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'openResource', {
      serverName: 'github',
      uri: 'file:///big',
    });
    const text = result.result as string;
    expect(text).toContain('[truncated');
    expect(text).toContain('10000 more chars]');
    // The truncated output should be shorter than the original
    expect(text.length).toBeLessThan(longText.length);
  });

  it('openResource returns an error string when mcp.readResource throws', async () => {
    const deps = createMockDeps({
      readResource: vi.fn().mockRejectedValue(new Error('resource not found')),
    });
    const ext = createMcpResourceViewerExt.create(deps);
    const result = await callTool(ext, 'openResource', {
      serverName: 'github',
      uri: 'file:///missing.txt',
    });
    const text = result.result as string;
    expect(text).toContain("Failed to read resource 'file:///missing.txt'");
    expect(text).toContain('resource not found');
  });

  // -------------------------------------------------------------------------
  // System prompt & introspect
  // -------------------------------------------------------------------------

  it('getSystemPromptPart returns a non-empty string mentioning both tools and pagination', () => {
    const deps = createMockDeps();
    const ext = createMcpResourceViewerExt.create(deps);
    const prompt = ext.getSystemPromptPart?.() ?? '';
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('listResources');
    expect(prompt).toContain('openResource');
    expect(prompt).toContain('cursor');
    expect(prompt).toContain('nextCursor');
  });

  it('introspect returns an empty object', () => {
    const deps = createMockDeps();
    const ext = createMcpResourceViewerExt.create(deps);
    const state = ext.introspect?.() as Record<string, unknown>;
    expect(state).toEqual({});
  });
});
