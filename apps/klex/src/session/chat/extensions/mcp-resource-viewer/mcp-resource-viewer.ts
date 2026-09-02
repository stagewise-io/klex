import type {
  ReadResourceResult,
  Resource,
  ResourceTemplateType,
} from '@modelcontextprotocol/client';
import type { ToolSet } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { Mcp } from '@/mcp';

import type { Extension, ExtensionFactory } from '../extension-api';

const MAX_CONTENT_CHARS = 50_000;

class McpResourceViewerExtension implements Extension {
  constructor(
    private readonly deps: {
      mcp: Mcp;
      logger: ModuleLogger;
    },
  ) {}

  onStart(): Promise<void> {
    this.deps.logger.info('MCP Resource Viewer extension started');
    return Promise.resolve();
  }

  getTools(): ToolSet {
    return {
      listResources: {
        inputSchema: z.object({
          serverName: z
            .string()
            .min(1)
            .describe(
              'The name of the MCP server to list resources from. Must match a configured MCP server name.',
            ),
          cursor: z
            .string()
            .optional()
            .describe(
              'Pagination cursor from a previous listResources call. Omit to fetch all resources in one request. If the response includes a nextCursor, pass it here to get the next page.',
            ),
        }),
        execute: async ({ serverName, cursor }) => {
          try {
            const result = await this.deps.mcp.listResources(
              serverName,
              cursor,
            );
            return { result: formatResourceList(serverName, result) };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              result: `Failed to list resources from server '${serverName}': ${message}`,
            };
          }
        },
      },
      openResource: {
        inputSchema: z.object({
          serverName: z
            .string()
            .min(1)
            .describe('The name of the MCP server that owns the resource.'),
          uri: z
            .string()
            .min(1)
            .describe(
              'The URI of the resource to read. Use listResources first to discover available URIs.',
            ),
        }),
        execute: async ({ serverName, uri }) => {
          try {
            const result = await this.deps.mcp.readResource(serverName, uri);
            return { result: formatResourceContents(uri, result) };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              result: `Failed to read resource '${uri}' from server '${serverName}': ${message}`,
            };
          }
        },
      },
    } satisfies ToolSet;
  }

  getSystemPromptPart(): string {
    return [
      '# MCP Resource Viewer',
      '',
      'Use `listResources(serverName, cursor?)` to list resources and resource templates an MCP server offers.',
      'When `cursor` is omitted, all resources are fetched in one request. If the response includes a `nextCursor`, pass it as `cursor` to get the next page.',
      'Use `openResource(serverName, uri)` to read the content of a resource by its URI.',
      'The serverName must match a configured MCP server. Use listResources first to discover available URIs.',
    ].join('\n');
  }

  introspect(): Record<string, unknown> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatResourceList(
  serverName: string,
  result: {
    resources: Resource[];
    resourceTemplates: ResourceTemplateType[];
    nextCursor?: string;
  },
): string {
  const { resources, resourceTemplates, nextCursor } = result;

  if (resources.length === 0 && resourceTemplates.length === 0) {
    return `No resources or resource templates available on server '${serverName}'.`;
  }

  const lines: string[] = [];

  if (resources.length > 0) {
    lines.push(`Resources (${resources.length}):`);
    for (const r of resources) {
      lines.push(formatResourceEntry(r));
    }
  }

  if (resourceTemplates.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Resource Templates (${resourceTemplates.length}):`);
    for (const t of resourceTemplates) {
      lines.push(formatResourceTemplateEntry(t));
    }
  }

  if (nextCursor) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `More resources available. Pass cursor=${JSON.stringify(nextCursor)} to listResources to get the next page.`,
    );
  }

  return lines.join('\n');
}

function formatResourceEntry(r: Resource): string {
  const parts: string[] = [
    `name: ${JSON.stringify(r.name)}`,
    `uri: ${JSON.stringify(r.uri)}`,
  ];
  if (r.mimeType) parts.push(`mimeType: ${JSON.stringify(r.mimeType)}`);
  if (r.description)
    parts.push(`description: ${JSON.stringify(r.description)}`);
  if (r.size != null) parts.push(`size: ${r.size}`);
  return `- ${parts.join('  ')}`;
}

function formatResourceTemplateEntry(t: ResourceTemplateType): string {
  const parts: string[] = [
    `name: ${JSON.stringify(t.name)}`,
    `uriTemplate: ${JSON.stringify(t.uriTemplate)}`,
  ];
  if (t.mimeType) parts.push(`mimeType: ${JSON.stringify(t.mimeType)}`);
  if (t.description)
    parts.push(`description: ${JSON.stringify(t.description)}`);
  return `- ${parts.join('  ')}`;
}

function formatResourceContents(
  uri: string,
  result: ReadResourceResult,
): string {
  const { contents } = result;

  if (contents.length === 0) {
    return `Resource '${uri}' returned no content.`;
  }

  const blocks: string[] = [];

  for (const content of contents) {
    if ('text' in content) {
      const truncated = truncate(content.text, MAX_CONTENT_CHARS);
      const header =
        content.mimeType != null
          ? `Text content (mimeType: ${content.mimeType})`
          : 'Text content';
      blocks.push(`${header}:\n${truncated}`);
    } else if ('blob' in content) {
      const truncated = truncate(content.blob, MAX_CONTENT_CHARS);
      const header =
        content.mimeType != null
          ? `Blob content (mimeType: ${content.mimeType}, base64-encoded)`
          : 'Blob content (base64-encoded)';
      blocks.push(`${header}:\n${truncated}`);
    }
  }

  return blocks.join('\n---\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated — ${text.length - max} more chars]`;
}

export const createMcpResourceViewerExt: ExtensionFactory = {
  identifier: 'io.stagewise/mcp-resource-viewer',
  displayName: 'MCP Resource Viewer',
  create: (deps) =>
    new McpResourceViewerExtension({
      mcp: deps.mcp,
      logger: deps.logger,
    }),
};
