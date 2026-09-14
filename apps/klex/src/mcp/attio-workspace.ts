import type { CallToolResult, Client } from '@modelcontextprotocol/client';
import { z } from 'zod';

import type { McpServerConfig } from '@/config';

const workspaceSchema = z.object({
  workspace_name: z.string().trim().min(1).max(300),
  workspace_slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(200),
});

export function isAttioServer(config: McpServerConfig): boolean {
  return !('command' in config) && config.url === 'https://mcp.attio.com/mcp';
}

export function parseAttioWorkspace(result: CallToolResult) {
  if (result.isError) return undefined;
  // Attio returns whoami as TOON text; also accept structured MCP output.
  const fields: Record<string, unknown> = {};
  for (const content of result.content) {
    if (content.type !== 'text') continue;
    for (const line of content.text.split('\n')) {
      const match = /^(workspace_name|workspace_slug): (.+)$/.exec(line);
      if (!match?.[1] || !match[2]) continue;
      let value: unknown = match[2].trim();
      if (typeof value === 'string' && value.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          return undefined;
        }
      }
      fields[match[1]] = value;
    }
  }
  const parsed = workspaceSchema.safeParse(result.structuredContent ?? fields);
  return parsed.success
    ? { name: parsed.data.workspace_name, slug: parsed.data.workspace_slug }
    : undefined;
}

export async function readAttioWorkspace(client: Client, signal: AbortSignal) {
  try {
    const result = await client.callTool(
      { name: 'whoami', arguments: {} },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) },
    );
    return parseAttioWorkspace(result);
  } catch {
    // Display metadata must not prevent an otherwise usable MCP connection.
    return undefined;
  }
}
