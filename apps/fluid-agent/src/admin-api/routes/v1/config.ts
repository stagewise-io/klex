import type { ModuleLogger } from '@stagewise/logger';
import type { Context } from 'hono';
import type { Config, FluidConfig } from '@/config';
import { ConfigValidationError } from '@/config';

const REDACTED = '[REDACTED]';

export interface ConfigRouteDependencies {
  config: Config;
  logger: ModuleLogger;
}

export function redactConfig(config: FluidConfig): FluidConfig {
  return {
    ...config,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([providerId, provider]) => [
        providerId,
        'preset' in provider
          ? {
              ...provider,
              auth: redactAuth(provider.auth),
            }
          : {
              ...provider,
              endpoints: Object.fromEntries(
                Object.entries(provider.endpoints).map(
                  ([endpointId, endpoint]) => [
                    endpointId,
                    {
                      ...endpoint,
                      auth: redactAuth(endpoint.auth),
                    },
                  ],
                ),
              ),
            },
      ]),
    ),
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => [
        name,
        'url' in server
          ? { ...server, headers: redactHeaders(server.headers) }
          : { ...server, args: server.args?.slice(), env: { ...server.env } },
      ]),
    ),
    modelSelection: {
      chat: config.modelSelection.chat.slice(),
      compression: config.modelSelection.compression.slice(),
      memory: config.modelSelection.memory.slice(),
    },
  };
}

export function getConfig(deps: ConfigRouteDependencies) {
  return (c: Context) => c.json(redactConfig(deps.config.get()));
}

export function putConfig(deps: ConfigRouteDependencies) {
  return async (c: Context) => {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be valid JSON' }, 400);
    }

    try {
      const config = await deps.config.replace(input);
      return c.json(redactConfig(config));
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 400);
      }

      deps.logger.error({ error }, 'Config update failed');
      return c.json({ error: 'Failed to update config' }, 500);
    }
  };
}

function redactAuth(auth: {
  apiKey?: string;
  headers?: Record<string, string>;
}): { apiKey?: string; headers?: Record<string, string> } {
  return {
    ...auth,
    apiKey: auth.apiKey ? REDACTED : auth.apiKey,
    headers: redactHeaders(auth.headers),
  };
}

function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.keys(headers).map((name) => [name, REDACTED]),
  );
}
