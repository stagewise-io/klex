import {
  type CallToolResult,
  Client,
  type Tool as McpToolDefinition,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  type Transport,
  UnauthorizedError,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { PushNotificationNotification } from '@stagewise/mcp-extension-push-notifications';
import {
  type RegisteredPushNotificationsClient,
  registerPushNotificationsClient,
} from '@stagewise/mcp-extension-push-notifications/client';
import type {
  RealtimeMediaExtensionCapability,
  RealtimeMediaNotification,
} from '@stagewise/mcp-extension-realtime-media';
import {
  type RegisteredRealtimeMediaClient,
  registerRealtimeMediaClient,
} from '@stagewise/mcp-extension-realtime-media/client';

import type { McpServerConfig } from '@/config';
import type { JsonObject } from '@/tool-provider';

import type {
  OAuthAuthorizationSession,
  OAuthAuthorizationSessionFactory,
} from './oauth/callback';
import {
  createDiscoveryAuthenticatedFetch,
  type DiscoveryCloudAuthProvider,
} from './oauth/protected-resource';
import { McpOAuthProvider } from './oauth/provider';
import type { McpOAuthStore } from './oauth/store';

export class McpAuthorizationRequiredError extends Error {
  public constructor(cause: unknown) {
    super('MCP server authorization is required', { cause });
    this.name = 'McpAuthorizationRequiredError';
  }
}

export interface McpConnection {
  readonly namespace: string;
  readonly tools: readonly McpToolDefinition[];
  readonly pushNotifications: RegisteredPushNotificationsClient;
  readonly supportsPushNotifications: boolean;
  readonly realtimeMedia: RegisteredRealtimeMediaClient | undefined;
  readonly supportsRealtimeMedia: boolean;
  invoke(
    tool: McpToolDefinition,
    input: JsonObject,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type CloudAuthProvider = DiscoveryCloudAuthProvider;

export interface ConnectMcpServerOptions {
  namespace: string;
  config: McpServerConfig;
  signal: AbortSignal;
  realtimeMediaCapability?: RealtimeMediaExtensionCapability;
  cloudAuth?: CloudAuthProvider;
  onToolsChanged(connection: McpConnection): void;
  onPushNotification(
    connection: McpConnection,
    notification: PushNotificationNotification,
  ): void | Promise<void>;
  onRealtimeMediaNotification(
    connection: McpConnection,
    notification: RealtimeMediaNotification,
  ): void | Promise<void>;
  onDisconnect(connection: McpConnection): void;
  onAuthorizationStatus?(
    status: 'authorization_required' | 'authorizing' | 'connecting',
  ): void;
  oauth?: {
    sessionFactory?: OAuthAuthorizationSessionFactory;
    store: McpOAuthStore;
  };
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
    readonly realtimeMedia: RegisteredRealtimeMediaClient | undefined,
    readonly supportsRealtimeMedia: boolean,
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
  const realtimeMedia = options.realtimeMediaCapability
    ? registerRealtimeMediaClient(client, {
        capability: options.realtimeMediaCapability,
        onNotification: async (notification) => {
          if (connection)
            await options.onRealtimeMediaNotification(connection, notification);
        },
      })
    : undefined;
  const oauth = await createOAuthTransportOptions(options);
  let transport = createTransport(
    options.config,
    oauth?.provider,
    options.cloudAuth,
  );
  client.onclose = () => {
    if (connection && !expectedClose) options.onDisconnect(connection);
  };

  const onAbort = () => void client.close();
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      await client.connect(transport, { signal: options.signal });
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !oauth?.callback)
        throw error;
      options.onAuthorizationStatus?.('authorizing');
      let callback: URLSearchParams;
      try {
        callback = await oauth.callback;
      } catch (callbackError) {
        throw new McpAuthorizationRequiredError(callbackError);
      }
      if (!(transport instanceof StreamableHTTPClientTransport)) {
        throw new Error('OAuth requires an HTTP MCP transport');
      }
      try {
        await transport.finishAuth(callback);
      } catch (finishError) {
        throw new McpAuthorizationRequiredError(finishError);
      }
      transport = createTransport(
        options.config,
        oauth.provider,
        options.cloudAuth,
      );
      options.onAuthorizationStatus?.('connecting');
      await client.connect(transport, { signal: options.signal });
    }
    const [supportsPushNotifications, supportsRealtimeMedia, result] =
      await Promise.all([
        pushNotifications.serverSupportsPushNotifications({
          request: { signal: options.signal },
        }),
        realtimeMedia
          ? realtimeMedia.serverSupportsRealtimeMedia({
              request: { signal: options.signal },
            })
          : false,
        client.listTools(undefined, { signal: options.signal }),
      ]);
    connection = new McpServerConnection(
      options.namespace,
      client,
      pushNotifications,
      supportsPushNotifications,
      realtimeMedia,
      supportsRealtimeMedia,
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
    const connectionError =
      error instanceof UnauthorizedError
        ? new McpAuthorizationRequiredError(error)
        : error;
    if (connectionError instanceof McpAuthorizationRequiredError) {
      options.onAuthorizationStatus?.('authorization_required');
    }
    throw connectionError;
  } finally {
    await oauth?.session.close().catch(() => undefined);
    options.signal.removeEventListener('abort', onAbort);
  }
}

export function resolveVersionNegotiation(
  config: McpServerConfig,
): VersionNegotiationOptions {
  return { mode: config.versionNegotiation ?? 'auto' };
}

async function createOAuthTransportOptions(
  options: ConnectMcpServerOptions,
): Promise<
  | {
      callback?: Promise<URLSearchParams>;
      provider: OAuthClientProvider;
      session: OAuthAuthorizationSession;
    }
  | undefined
> {
  if (
    'command' in options.config ||
    !shouldUseAutomaticOAuth(options.config) ||
    !options.oauth?.sessionFactory
  ) {
    return undefined;
  }

  const session = await options.oauth.sessionFactory.start({
    serverName: options.namespace,
    serverUrl: options.config.url,
  });
  let callback: Promise<URLSearchParams> | undefined;
  const provider = new McpOAuthProvider({
    onAuthorizationRedirect: (authorizationUrl) => {
      const state = authorizationUrl.searchParams.get('state');
      if (!state)
        throw new Error('OAuth authorization URL did not include state');
      callback = session.authorize({
        authorizationUrl,
        signal: options.signal,
        state,
      });
    },
    redirectUrl: session.redirectUrl,
    serverName: `${options.namespace}\u0000${options.config.url}`,
    store: options.oauth.store,
  });
  return {
    get callback() {
      return callback;
    },
    provider,
    session,
  };
}

export function shouldUseAutomaticOAuth(config: McpServerConfig): boolean {
  return (
    !('command' in config) &&
    !Object.keys(config.headers ?? {}).some(
      (header) => header.toLowerCase() === 'authorization',
    )
  );
}

export function createTransport(
  config: McpServerConfig,
  authProvider?: OAuthClientProvider,
  cloudAuth?: CloudAuthProvider,
): Transport {
  if ('command' in config) {
    return new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(authProvider ? { authProvider } : {}),
    ...(config.headers
      ? { requestInit: { headers: new Headers(config.headers) } }
      : {}),
    ...(cloudAuth && shouldUseAutomaticOAuth(config)
      ? { fetch: createDiscoveryAuthenticatedFetch(cloudAuth, config.url) }
      : {}),
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 5,
    },
  });
}
