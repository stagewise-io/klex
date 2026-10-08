import type { Config } from './config';
import type { HttpServerConfig, McpServerConfig } from './types';

export class McpResourceConflict extends Error {
  constructor() {
    super('Connector name belongs to a different resource');
  }
}

function requireResource(
  server: McpServerConfig,
  url: string,
): HttpServerConfig {
  if ('command' in server || new URL(server.url).href !== new URL(url).href) {
    throw new McpResourceConflict();
  }
  return server;
}

export async function reconcileHttpMcpServer(
  config: Config,
  input: { name: string; url: string },
): Promise<'created' | 'already_present'> {
  let status: 'created' | 'already_present' = 'already_present';
  await config.mutate((current) => {
    const existing = Object.hasOwn(current.mcpServers, input.name)
      ? current.mcpServers[input.name]
      : undefined;
    if (existing) {
      requireResource(existing, input.url);
      return current;
    }
    status = 'created';
    return {
      ...current,
      mcpServers: { ...current.mcpServers, [input.name]: { url: input.url } },
    };
  });
  return status;
}

export async function removeMatchingHttpMcpServers(
  config: Config,
  input: { names: readonly string[]; url: string },
): Promise<'removed' | 'already_absent'> {
  let status: 'removed' | 'already_absent' = 'already_absent';
  await config.mutate((current) => {
    const names = [...new Set(input.names)].filter((name) =>
      Object.hasOwn(current.mcpServers, name),
    );
    for (const name of names) {
      const server = current.mcpServers[name];
      if (server) requireResource(server, input.url);
    }
    if (names.length === 0) return current;
    const mcpServers = { ...current.mcpServers };
    for (const name of names) delete mcpServers[name];
    status = 'removed';
    return { ...current, mcpServers };
  });
  return status;
}
