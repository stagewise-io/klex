import {
  type CallToolResult,
  Client,
  type Tool as McpToolDefinition,
  StreamableHTTPClientTransport,
  type Transport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { PushNotificationNotification } from '@stagewise/mcp-extension-push-notifications';
import {
  type RegisteredPushNotificationsClient,
  registerPushNotificationsClient,
} from '@stagewise/mcp-extension-push-notifications/client';

import type { McpServerConfig } from '@/config';
import type { JsonObject } from '@/tool-provider';

export interface McpConnection {
  readonly namespace: string;
  readonly tools: readonly McpToolDefinition[];
  readonly pushNotifications: RegisteredPushNotificationsClient;
  readonly supportsPushNotifications: boolean;
  invoke(
    tool: McpToolDefinition,
    input: JsonObject,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface ConnectMcpServerOptions {
  namespace: string;
  config: McpServerConfig;
  signal: AbortSignal;
  onToolsChanged(connection: McpConnection): void;
  onPushNotification(
    connection: McpConnection,
    notification: PushNotificationNotification,
  ): void | Promise<void>;
  onDisconnect(connection: McpConnection): void;
}

export type McpConnectionFactory = (
  options: ConnectMcpServerOptions,
) => Promise<McpConnection>;

class McpServerConnection implements McpConnection {
  private closed = false;

  constructor(
    readonly namespace: string,
    private readonly client: Client,
    readonly pushNotifications: RegisteredPushNotificationsClient,
    readonly supportsPushNotifications: boolean,
    private currentTools: readonly McpToolDefinition[],
  ) {}

  get tools(): readonly McpToolDefinition[] {
    return this.currentTools;
  }

  replaceTools(tools: readonly McpToolDefinition[]): void {
    this.currentTools = tools;
  }

  async invoke(
    tool: McpToolDefinition,
    input: JsonObject,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (this.closed)
      throw new Error(`MCP server is unavailable: ${this.namespace}`);
    return this.client.callTool(
      { name: tool.name, arguments: input },
      { signal, toolDefinition: tool },
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }
}

export async function connectMcpServer(
  options: ConnectMcpServerOptions,
): Promise<McpConnection> {
  let connection: McpServerConnection | undefined;
  let expectedClose = false;
  const client = new Client(
    { name: 'klex', version: '1.0.0' },
    {
      versionNegotiation: resolveVersionNegotiation(options.config),
      listChanged: {
        tools: {
          onChanged: (error, _tool) => {
            if (error || !connection) return;
            void client
              .listTools(undefined, { cacheMode: 'refresh' })
              .then((result) => {
                if (!connection) return;
                connection.replaceTools(result.tools);
                options.onToolsChanged(connection);
              })
              .catch(() => undefined);
          },
        },
      },
    },
  );
  const pushNotifications = registerPushNotificationsClient(client, {
    onEvent: async (notification) => {
      if (connection)
        await options.onPushNotification(connection, notification);
    },
  });
  const transport = createTransport(options.config);
  client.onclose = () => {
    if (connection && !expectedClose) options.onDisconnect(connection);
  };

  const onAbort = () => void client.close();
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect(transport, { signal: options.signal });
    const [supportsPushNotifications, result] = await Promise.all([
      pushNotifications.serverSupportsPushNotifications({
        request: { signal: options.signal },
      }),
      client.listTools(undefined, { signal: options.signal }),
    ]);
    connection = new McpServerConnection(
      options.namespace,
      client,
      pushNotifications,
      supportsPushNotifications,
      result.tools,
    );
    const originalClose = connection.close.bind(connection);
    connection.close = async () => {
      expectedClose = true;
      await originalClose();
    };
    return connection;
  } catch (error) {
    expectedClose = true;
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    options.signal.removeEventListener('abort', onAbort);
  }
}

export function resolveVersionNegotiation(
  config: McpServerConfig,
): VersionNegotiationOptions {
  return { mode: config.versionNegotiation ?? 'auto' };
}

function createTransport(config: McpServerConfig): Transport {
  if ('command' in config) {
    return new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers
      ? { requestInit: { headers: new Headers(config.headers) } }
      : {}),
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 5,
    },
  });
}
