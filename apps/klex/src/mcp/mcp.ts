import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import type {
  PushNotification,
  PushNotificationNotification,
} from '@stagewise/mcp-extension-push-notifications';
import type {
  RealtimeMediaClientAcceptResult,
  RealtimeMediaExtensionCapability,
  RealtimeMediaNotification,
} from '@stagewise/mcp-extension-realtime-media';

import type { CloudConnectivity } from '@/cloud-connectivity';
import type { Config, McpServerConfig } from '@/config';
import {
  createInMemoryPushNotificationInbox,
  type PushNotificationInbox,
} from '@/mcp/push-notification-inbox';
import type {
  JsonObject,
  JsonValue,
  ToolDescription,
  ToolProvider,
  ToolReference,
  ToolRequestContext,
  ToolSearchOptions,
  ToolSearchResult,
  ToolSnapshot,
} from '@/tool-provider';

import {
  connectMcpServer,
  McpAuthorizationRequiredError,
  type McpConnection,
  type McpConnectionFactory,
} from './connection';
import type { OAuthAuthorizationSessionFactory } from './oauth/callback';
import { LocalOAuthAuthorizationCoordinator } from './oauth/coordinator';
import { LocalOAuthCallbackReceiver } from './oauth/local-callback';
import { LocalBrowserOAuthPresenter } from './oauth/presenter';
import { McpOAuthStore } from './oauth/store';
import {
  buildMcpRegistry,
  canonicalConfigSignature,
  type McpRegistry,
  normalizeCallToolResult,
} from './registry';

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const EVENT_PAGE_SIZE = 100;

export interface McpPushNotification {
  namespace: string;
  event: PushNotification;
}

export type McpPushNotificationListener = (
  event: McpPushNotification,
) => void | Promise<void>;

export interface McpRealtimeMediaNotification {
  namespace: string;
  notification: RealtimeMediaNotification;
}

export type McpRealtimeMediaNotificationListener = (
  event: McpRealtimeMediaNotification,
) => void | Promise<void>;

export interface McpRealtimeMediaAvailability {
  namespace: string;
  available: boolean;
}

export type McpRealtimeMediaAvailabilityListener = (
  event: McpRealtimeMediaAvailability,
) => void | Promise<void>;

/**
 * Connection status of an MCP server.
 * - `connected` — connection is active and tools are available.
 * - `connecting` — a connection attempt is in progress.
 * - `authorization_required` — OAuth consent is required but could not be completed.
 * - `authorizing` — an interactive OAuth authorization is in progress.
 * - `error` — the connection failed and is awaiting retry.
 * - `disconnected` — the server is not configured or was removed.
 */
export type McpConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'authorization_required'
  | 'authorizing'
  | 'error'
  | 'disconnected';

/** A single MCP server with its config and connection status. */
export interface McpServerInfo {
  /** Unique namespace / server name. */
  name: string;
  /** Current connection status. */
  status: McpConnectionStatus;
  /** Number of tools exposed by this server (0 if not connected). */
  toolCount: number;
  /** Whether the server supports Push Notifications. */
  supportsPushNotifications: boolean;
  /** Whether the server supports Realtime Media. */
  supportsRealtimeMedia: boolean;
  /** Server type: stdio or http. */
  transport: 'stdio' | 'http';
}

/** Record of a tool call made to an MCP server. */
export interface McpToolCallRecord {
  /** Unique record ID. */
  id: string;
  /** MCP server namespace. */
  namespace: string;
  /** Tool name that was called. */
  toolName: string;
  /** Input arguments passed to the tool. */
  input: JsonObject;
  /** Result returned by the tool (null if the call has not completed yet). */
  result: JsonValue | null;
  /** True if the tool call resulted in an error. */
  isError: boolean;
  /** Session ID that initiated the call, if known. */
  sessionId: string | null;
  /** ISO timestamp when the call was initiated. */
  startedAt: string;
  /** ISO timestamp when the call completed, if it has. */
  finishedAt: string | null;
}

export interface Mcp extends ToolProvider {
  start(): Promise<void>;
  onPushNotification(listener: McpPushNotificationListener): () => void;
  onRealtimeMediaNotification(
    listener: McpRealtimeMediaNotificationListener,
  ): () => void;
  onRealtimeMediaAvailability(
    listener: McpRealtimeMediaAvailabilityListener,
  ): () => void;
  acceptRealtimeMediaSession(
    namespace: string,
    sessionId: string,
  ): Promise<RealtimeMediaClientAcceptResult>;
  rejectRealtimeMediaSession(
    namespace: string,
    sessionId: string,
  ): Promise<void>;
  endRealtimeMediaSession(namespace: string, sessionId: string): Promise<void>;
  close(): Promise<void>;

  /** Returns the current status of all configured MCP servers. */
  getServerStatuses(): McpServerInfo[];
  /** Returns the recorded history of tool calls to MCP servers. */
  getToolCallHistory(): McpToolCallRecord[];
}

export interface McpDependencies {
  logging: RootLogger;
  config: Config;
  realtimeMediaCapability?: RealtimeMediaExtensionCapability;
  dataDirectory?: string;
  connect?: McpConnectionFactory;
  cloudConnectivity?: CloudConnectivity;
}

interface PushNotificationWorker {
  connection: McpConnection;
  controller: AbortController;
  notifications: PushNotificationNotification[];
  queue: Promise<void>;
  recovered: boolean;
}

interface RealtimeMediaWorker {
  connection: McpConnection;
  controller: AbortController;
}

interface McpConnectionAttempt {
  controller: AbortController;
}

interface McpServerRuntime {
  namespace: string;
  config: McpServerConfig;
  signature: string;
  status: Exclude<McpConnectionStatus, 'disconnected'>;
  connection?: McpConnection;
  attempt?: McpConnectionAttempt;
  retryAttempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

class McpModule implements Mcp {
  private readonly servers = new Map<string, McpServerRuntime>();
  private readonly eventWorkers = new Map<string, PushNotificationWorker>();
  private readonly eventListeners = new Set<McpPushNotificationListener>();
  private readonly realtimeWorkers = new Map<string, RealtimeMediaWorker>();
  private readonly realtimeListeners =
    new Set<McpRealtimeMediaNotificationListener>();
  private readonly realtimeAvailabilityListeners =
    new Set<McpRealtimeMediaAvailabilityListener>();
  private readonly realtimeAvailableNamespaces = new Set<string>();
  private registry: McpRegistry = new Map();
  private started = false;
  private unsubscribe: (() => void) | undefined;
  /** Recorded tool call history (newest first). */
  private readonly toolCallHistory: McpToolCallRecord[] = [];
  /** Maximum number of tool call records to keep. */
  private static readonly MAX_TOOL_CALL_HISTORY = 500;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      config: Config;
      pushNotificationInbox: PushNotificationInbox;
      realtimeMediaCapability: RealtimeMediaExtensionCapability | undefined;
      connect: McpConnectionFactory;
      cloudConnectivity: CloudConnectivity | undefined;
      closeOAuth: () => Promise<void>;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.deps.config.subscribe(() => {
      this.scheduleReconcile(this.deps.config.getMcpServers());
    });
    const configuredServerCount = Object.keys(
      this.deps.config.getMcpServers(),
    ).length;
    this.scheduleReconcile(this.deps.config.getMcpServers());
    this.deps.logger.info(
      { configuredServerCount },
      'MCP started; environment reconciliation continues in background',
    );
  }

  onPushNotification(listener: McpPushNotificationListener): () => void {
    this.eventListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.eventListeners.delete(listener);
    };
  }

  onRealtimeMediaNotification(
    listener: McpRealtimeMediaNotificationListener,
  ): () => void {
    this.realtimeListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.realtimeListeners.delete(listener);
    };
  }

  onRealtimeMediaAvailability(
    listener: McpRealtimeMediaAvailabilityListener,
  ): () => void {
    this.realtimeAvailabilityListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.realtimeAvailabilityListeners.delete(listener);
    };
  }

  async acceptRealtimeMediaSession(
    namespace: string,
    sessionId: string,
  ): Promise<RealtimeMediaClientAcceptResult> {
    return this.requireRealtimeConnection(namespace).realtimeMedia.accept(
      sessionId,
    );
  }

  async rejectRealtimeMediaSession(
    namespace: string,
    sessionId: string,
  ): Promise<void> {
    await this.requireRealtimeConnection(namespace).realtimeMedia.reject(
      sessionId,
    );
  }

  async endRealtimeMediaSession(
    namespace: string,
    sessionId: string,
  ): Promise<void> {
    await this.requireRealtimeConnection(namespace).realtimeMedia.end(
      sessionId,
    );
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.deps.closeOAuth();
    const connections = [...this.servers.values()].flatMap((runtime) => {
      const connection = this.invalidateRuntime(runtime);
      return connection ? [connection] : [];
    });
    this.publishRegistry();
    await Promise.allSettled(
      connections.map((connection) => connection.close()),
    );
    this.deps.logger.info('MCP stopped');
  }

  async snapshot(_context: ToolRequestContext): Promise<ToolSnapshot> {
    return {
      namespaces: [...this.registry.entries()].map(([name, namespace]) => ({
        name,
        capabilities: [...namespace.tools.keys()].map((capability) => ({
          name: capability,
        })),
      })),
    };
  }

  async search(
    query: string,
    options: ToolSearchOptions,
    _context: ToolRequestContext,
  ): Promise<ToolSearchResult[]> {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const matches = [...this.registry.entries()].flatMap(
      ([namespace, registeredNamespace]) =>
        [...registeredNamespace.tools.values()].filter((entry) => {
          const id = `${namespace}.${entry.tool.name}`;
          const haystack =
            `${id} ${entry.tool.title ?? ''} ${entry.tool.description ?? ''}`.toLocaleLowerCase();
          return terms.every((term) => haystack.includes(term));
        }),
    );
    return matches.slice(0, options.limit ?? matches.length).map((entry) => ({
      reference: entry.descriptor.reference,
      ...(entry.tool.description
        ? { description: entry.tool.description }
        : {}),
    }));
  }

  async describe(
    reference: ToolReference,
    _context: ToolRequestContext,
  ): Promise<ToolDescription> {
    return this.getTool(reference).descriptor;
  }

  async invoke(
    reference: ToolReference,
    input: JsonObject,
    context: ToolRequestContext,
  ): Promise<JsonValue> {
    const { connection, tool } = this.getTool(reference);
    const record: McpToolCallRecord = {
      id: randomUUID(),
      namespace: reference.namespace,
      toolName: reference.name,
      input: structuredClone(input),
      result: null,
      isError: false,
      sessionId: context.sessionId ?? null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.addToolCallRecord(record);
    try {
      const result = await connection.invoke(tool, input, context.signal);
      const normalized = normalizeCallToolResult(result);
      record.result = normalized;
      record.isError = Boolean(result.isError);
      record.finishedAt = new Date().toISOString();
      return normalized;
    } catch (error) {
      record.isError = true;
      record.result = {
        error: error instanceof Error ? error.message : String(error),
      };
      record.finishedAt = new Date().toISOString();
      throw error;
    }
  }

  private getTool(reference: ToolReference) {
    const namespace = this.registry.get(reference.namespace);
    const tool = namespace?.tools.get(reference.name);
    if (!namespace || !tool)
      throw new Error(
        `Unknown MCP tool: ${reference.namespace}.${reference.name}`,
      );
    return { connection: namespace.connection, ...tool };
  }

  private scheduleReconcile(
    servers: Readonly<Record<string, McpServerConfig>>,
  ): void {
    if (!this.started) return;
    this.reconcile(structuredClone(servers));
  }

  private reconcile(servers: Readonly<Record<string, McpServerConfig>>): void {
    if (!this.started) return;
    this.deps.logger.debug(
      { configuredServerCount: Object.keys(servers).length },
      'MCP reconciliation started',
    );

    for (const runtime of [...this.servers.values()]) {
      const next = servers[runtime.namespace];
      if (next && runtime.signature === signature(next)) continue;
      const reason = next ? 'configuration-changed' : 'configuration-removed';
      const connection = this.invalidateRuntime(runtime);
      if (connection) this.closeConnection(connection, runtime.namespace);
      this.deps.logger.info(
        { namespace: runtime.namespace, reason },
        'MCP server disconnected',
      );
    }
    this.publishRegistry();

    for (const [namespace, config] of Object.entries(servers)) {
      if (this.servers.has(namespace)) continue;
      const runtime: McpServerRuntime = {
        namespace,
        config,
        signature: signature(config),
        status: 'connecting',
        retryAttempt: 0,
      };
      this.servers.set(namespace, runtime);
      this.activateRuntime(runtime);
    }

    this.deps.logger.debug(
      { configuredServerCount: this.servers.size },
      'MCP reconciliation completed',
    );
  }

  private activateRuntime(runtime: McpServerRuntime): void {
    if (
      !this.isCurrentRuntime(runtime) ||
      runtime.connection ||
      runtime.attempt
    )
      return;
    runtime.status = 'connecting';
    this.connectRuntime(runtime);
  }

  private connectRuntime(runtime: McpServerRuntime): void {
    if (
      !this.isCurrentRuntime(runtime) ||
      runtime.connection ||
      runtime.attempt
    )
      return;
    const attempt: McpConnectionAttempt = {
      controller: new AbortController(),
    };
    runtime.attempt = attempt;
    runtime.status = 'connecting';
    const cloudConnectivity = this.deps.cloudConnectivity;
    void this.deps
      .connect({
        namespace: runtime.namespace,
        config: runtime.config,
        signal: attempt.controller.signal,
        realtimeMediaCapability: this.deps.realtimeMediaCapability,
        ...(cloudConnectivity
          ? {
              cloudAuth: {
                getAccessToken: (resource: string, scopes: string[]) =>
                  cloudConnectivity.getAccessToken(resource, scopes),
                invalidate: (resource: string) =>
                  cloudConnectivity.invalidateAccessToken(resource),
                isTrustedAuthorizationServer: (issuer: string) =>
                  cloudConnectivity.isTrustedAuthorizationServer(issuer),
              },
            }
          : {}),
        onToolsChanged: (changed) => {
          if (!this.isCurrentConnection(runtime, changed)) return;
          this.publishRegistry();
          this.deps.logger.info(
            { namespace: runtime.namespace, toolCount: changed.tools.length },
            'MCP server tools updated',
          );
        },
        onPushNotification: (changed, notification) =>
          this.enqueuePushNotification(changed, notification),
        onRealtimeMediaNotification: (changed, notification) =>
          this.publishRealtimeNotification(changed, notification),
        onAuthorizationStatus: (status) => {
          if (!this.isCurrentAttempt(runtime, attempt)) return;
          runtime.status = status;
          this.publishRegistry();
        },
        onDisconnect: (disconnected) => {
          if (!this.isCurrentConnection(runtime, disconnected)) return;
          runtime.connection = undefined;
          runtime.status = 'error';
          this.stopEventWorker(runtime.namespace);
          this.stopRealtimeWorker(runtime.namespace);
          this.publishRegistry();
          this.deps.logger.warn(
            { namespace: runtime.namespace },
            'MCP server disconnected unexpectedly',
          );
          this.scheduleReconnect(runtime);
        },
      })
      .then((connection) => {
        if (!this.isCurrentAttempt(runtime, attempt)) {
          this.closeConnection(connection, runtime.namespace);
          return;
        }
        runtime.attempt = undefined;
        runtime.connection = connection;
        runtime.status = 'connected';
        this.clearRetry(runtime);
        this.publishRegistry();
        if (connection.supportsPushNotifications)
          this.startEventWorker(connection);
        if (connection.supportsRealtimeMedia)
          this.startRealtimeWorker(connection);
        this.deps.logger.info(
          {
            namespace: runtime.namespace,
            toolCount: connection.tools.length,
            supportsPushNotifications: connection.supportsPushNotifications,
            supportsRealtimeMedia: connection.supportsRealtimeMedia,
          },
          'MCP server connected',
        );
      })
      .catch((error: unknown) => {
        if (!this.isCurrentAttempt(runtime, attempt)) return;
        runtime.attempt = undefined;
        const authorizationRequired =
          error instanceof McpAuthorizationRequiredError;
        runtime.status = authorizationRequired
          ? 'authorization_required'
          : 'error';
        if (authorizationRequired) {
          this.deps.logger.info(
            { namespace: runtime.namespace },
            'MCP server requires authorization',
          );
          return;
        }
        const isRetry = runtime.retryAttempt > 0;
        if (isRetry) {
          this.deps.logger.debug(
            {
              error: safeDiagnosticError(error),
              namespace: runtime.namespace,
              retryAttempt: runtime.retryAttempt,
            },
            'MCP connection retry failed',
          );
        } else {
          this.deps.logger.warn(
            {
              error: safeDiagnosticError(error),
              namespace: runtime.namespace,
            },
            'MCP connection failed — will retry with exponential backoff',
          );
        }
        this.scheduleReconnect(runtime);
      });
  }

  private invalidateRuntime(
    runtime: McpServerRuntime,
  ): McpConnection | undefined {
    if (this.servers.get(runtime.namespace) === runtime)
      this.servers.delete(runtime.namespace);
    runtime.attempt?.controller.abort();
    runtime.attempt = undefined;
    this.clearRetry(runtime);
    this.stopEventWorker(runtime.namespace);
    this.stopRealtimeWorker(runtime.namespace);
    const connection = runtime.connection;
    runtime.connection = undefined;
    return connection;
  }

  private isCurrentRuntime(runtime: McpServerRuntime): boolean {
    return this.started && this.servers.get(runtime.namespace) === runtime;
  }

  private isCurrentAttempt(
    runtime: McpServerRuntime,
    attempt: McpConnectionAttempt,
  ): boolean {
    return this.isCurrentRuntime(runtime) && runtime.attempt === attempt;
  }

  private isCurrentConnection(
    runtime: McpServerRuntime,
    connection: McpConnection,
  ): boolean {
    return this.isCurrentRuntime(runtime) && runtime.connection === connection;
  }

  private closeConnection(connection: McpConnection, namespace: string): void {
    void connection.close().catch((error: unknown) => {
      this.deps.logger.warn(
        { error, namespace },
        'MCP connection close failed',
      );
    });
  }

  private startEventWorker(connection: McpConnection): void {
    this.stopEventWorker(connection.namespace);
    const worker: PushNotificationWorker = {
      connection,
      controller: new AbortController(),
      notifications: [],
      queue: Promise.resolve(),
      recovered: false,
    };
    this.eventWorkers.set(connection.namespace, worker);
    void this.runEventWorker(worker);
  }

  private async runEventWorker(worker: PushNotificationWorker): Promise<void> {
    let attempt = 0;
    while (this.isCurrentWorker(worker)) {
      try {
        worker.recovered = false;
        const subscription = await worker.connection.pushNotifications.listen(
          undefined,
          { request: { signal: worker.controller.signal } },
        );
        await this.recoverEvents(worker);
        worker.recovered = true;
        this.drainNotifications(worker);
        attempt = 0;
        await subscription.closed;
        await worker.queue;
        if (this.isCurrentWorker(worker)) {
          throw new Error('Push Notifications subscription closed');
        }
      } catch (error) {
        if (!this.isCurrentWorker(worker)) return;
        this.deps.logger.warn(
          { error, namespace: worker.connection.namespace },
          'Push Notifications subscription failed',
        );
        attempt += 1;
        await abortableDelay(
          Math.min(RETRY_INITIAL_MS * 2 ** (attempt - 1), RETRY_MAX_MS),
          worker.controller.signal,
        ).catch(() => undefined);
      }
    }
  }

  private async recoverEvents(worker: PushNotificationWorker): Promise<void> {
    while (this.isCurrentWorker(worker)) {
      const page = await worker.connection.pushNotifications.getEvents(
        { limit: EVENT_PAGE_SIZE },
        { request: { signal: worker.controller.signal } },
      );
      if (page.events.length === 0 && page.hasMore) {
        throw new Error(
          'Push Notifications returned an empty non-terminal page',
        );
      }
      await this.commitEvents(
        worker,
        page.events,
        page.events.map((event) => event.eventId),
      );
      if (!page.hasMore) return;
    }
  }

  private enqueuePushNotification(
    connection: McpConnection,
    notification: PushNotificationNotification,
  ): void {
    const worker = this.eventWorkers.get(connection.namespace);
    if (!worker || worker.connection !== connection) return;
    worker.notifications.push(notification);
    if (worker.recovered) this.drainNotifications(worker);
  }

  private drainNotifications(worker: PushNotificationWorker): void {
    const notifications = worker.notifications.splice(0);
    for (const notification of notifications) {
      worker.queue = worker.queue
        .then(() =>
          this.commitEvents(
            worker,
            [notification.params.event],
            [notification.params.event.eventId],
          ),
        )
        .catch((error: unknown) => {
          if (this.isCurrentWorker(worker))
            this.deps.logger.error(
              { error, namespace: worker.connection.namespace },
              'Push Notification ingestion failed',
            );
        });
    }
  }

  private async commitEvents(
    worker: PushNotificationWorker,
    events: readonly PushNotification[],
    eventIds: string[],
  ): Promise<void> {
    if (!this.isCurrentWorker(worker)) return;
    const accepted = await this.deps.pushNotificationInbox.commit(
      worker.connection.namespace,
      events,
    );
    for (const event of accepted)
      await this.publishPushNotification(worker, event);
    if (eventIds.length > 0) {
      await this.acknowledgeEvents(worker, eventIds);
    }
  }

  private async acknowledgeEvents(
    worker: PushNotificationWorker,
    eventIds: string[],
  ): Promise<void> {
    let attempt = 0;
    while (this.isCurrentWorker(worker)) {
      try {
        await worker.connection.pushNotifications.acknowledgeEvents(
          { eventIds },
          { request: { signal: worker.controller.signal } },
        );
        return;
      } catch (error) {
        if (!this.isCurrentWorker(worker)) return;
        attempt += 1;
        this.deps.logger.warn(
          { error, eventIds, namespace: worker.connection.namespace },
          'Push Notification acknowledgement failed',
        );
        await abortableDelay(
          Math.min(RETRY_INITIAL_MS * 2 ** (attempt - 1), RETRY_MAX_MS),
          worker.controller.signal,
        ).catch(() => undefined);
      }
    }
  }

  private async publishPushNotification(
    worker: PushNotificationWorker,
    event: PushNotification,
  ): Promise<void> {
    if (!this.isCurrentWorker(worker)) return;
    await Promise.allSettled(
      [...this.eventListeners].map(async (listener) => {
        try {
          await listener({
            namespace: worker.connection.namespace,
            event: structuredClone(event),
          });
        } catch (error) {
          this.deps.logger.error(
            { error, namespace: worker.connection.namespace },
            'MCP Push Notification listener failed',
          );
        }
      }),
    );
  }

  private stopEventWorker(namespace: string): void {
    const worker = this.eventWorkers.get(namespace);
    if (!worker) return;
    this.eventWorkers.delete(namespace);
    worker.controller.abort();
    worker.notifications.length = 0;
  }

  private isCurrentWorker(worker: PushNotificationWorker): boolean {
    return (
      this.started &&
      !worker.controller.signal.aborted &&
      this.servers.get(worker.connection.namespace)?.connection ===
        worker.connection &&
      this.eventWorkers.get(worker.connection.namespace) === worker
    );
  }

  private requireRealtimeConnection(namespace: string): McpConnection & {
    realtimeMedia: NonNullable<McpConnection['realtimeMedia']>;
  } {
    if (!this.deps.realtimeMediaCapability)
      throw new Error('Realtime Media is disabled in Klex configuration');
    const connection = this.servers.get(namespace)?.connection;
    if (!connection) throw new Error(`MCP server is unavailable: ${namespace}`);
    if (!connection.supportsRealtimeMedia || !connection.realtimeMedia) {
      throw new Error(
        `MCP server does not support Realtime Media: ${namespace}`,
      );
    }
    return connection as McpConnection & {
      realtimeMedia: NonNullable<McpConnection['realtimeMedia']>;
    };
  }

  private startRealtimeWorker(connection: McpConnection): void {
    this.stopRealtimeWorker(connection.namespace);
    const worker: RealtimeMediaWorker = {
      connection,
      controller: new AbortController(),
    };
    this.realtimeWorkers.set(connection.namespace, worker);
    this.publishRealtimeAvailability(connection.namespace, true);
    void this.runRealtimeWorker(worker);
  }

  private async runRealtimeWorker(worker: RealtimeMediaWorker): Promise<void> {
    try {
      const realtimeMedia = worker.connection.realtimeMedia;
      if (!realtimeMedia)
        throw new Error('Realtime Media client is unavailable');
      const subscription = await realtimeMedia.listen(undefined, {
        request: { signal: worker.controller.signal },
      });
      await subscription.closed;
      if (this.isCurrentRealtimeWorker(worker)) {
        throw new Error('Realtime Media subscription closed');
      }
    } catch (error) {
      if (!this.isCurrentRealtimeWorker(worker)) return;
      const runtime = this.servers.get(worker.connection.namespace);
      if (!runtime || runtime.connection !== worker.connection) return;
      this.deps.logger.warn(
        { error, namespace: worker.connection.namespace },
        'Realtime Media subscription failed; reconnecting MCP server',
      );
      runtime.connection = undefined;
      runtime.status = 'error';
      this.stopRealtimeWorker(runtime.namespace);
      this.stopEventWorker(runtime.namespace);
      this.publishRegistry();
      this.closeConnection(worker.connection, runtime.namespace);
      this.scheduleReconnect(runtime);
    }
  }

  private publishRealtimeNotification(
    connection: McpConnection,
    notification: RealtimeMediaNotification,
  ): void {
    const worker = this.realtimeWorkers.get(connection.namespace);
    if (!worker || worker.connection !== connection) return;
    for (const listener of this.realtimeListeners) {
      void Promise.resolve(
        listener({
          namespace: connection.namespace,
          notification: structuredClone(notification),
        }),
      ).catch((error: unknown) => {
        this.deps.logger.error(
          { error, namespace: connection.namespace },
          'MCP Realtime Media listener failed',
        );
      });
    }
  }

  private stopRealtimeWorker(namespace: string): void {
    const worker = this.realtimeWorkers.get(namespace);
    if (!worker) return;
    this.realtimeWorkers.delete(namespace);
    worker.controller.abort();
    this.publishRealtimeAvailability(namespace, false);
  }

  private publishRealtimeAvailability(
    namespace: string,
    available: boolean,
  ): void {
    const wasAvailable = this.realtimeAvailableNamespaces.has(namespace);
    if (wasAvailable === available) return;
    if (available) this.realtimeAvailableNamespaces.add(namespace);
    else this.realtimeAvailableNamespaces.delete(namespace);
    for (const listener of this.realtimeAvailabilityListeners) {
      void Promise.resolve(listener({ namespace, available })).catch(
        (error: unknown) => {
          this.deps.logger.error(
            { error, namespace },
            'MCP Realtime Media availability listener failed',
          );
        },
      );
    }
  }

  private isCurrentRealtimeWorker(worker: RealtimeMediaWorker): boolean {
    return (
      this.started &&
      !worker.controller.signal.aborted &&
      this.servers.get(worker.connection.namespace)?.connection ===
        worker.connection &&
      this.realtimeWorkers.get(worker.connection.namespace) === worker
    );
  }

  private scheduleReconnect(runtime: McpServerRuntime): void {
    if (!this.isCurrentRuntime(runtime) || runtime.retryTimer) return;
    runtime.retryAttempt += 1;
    const delay = Math.min(
      RETRY_INITIAL_MS * 2 ** (runtime.retryAttempt - 1),
      RETRY_MAX_MS,
    );
    const timer = setTimeout(() => {
      if (!this.isCurrentRuntime(runtime) || runtime.retryTimer !== timer)
        return;
      runtime.retryTimer = undefined;
      this.activateRuntime(runtime);
    }, delay);
    timer.unref?.();
    runtime.retryTimer = timer;
  }

  private clearRetry(runtime: McpServerRuntime): void {
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
    runtime.retryAttempt = 0;
  }

  private publishRegistry(): void {
    const connections = new Map<string, McpConnection>();
    for (const runtime of this.servers.values()) {
      if (runtime.connection)
        connections.set(runtime.namespace, runtime.connection);
    }
    this.registry = buildMcpRegistry(connections);
  }

  getServerStatuses(): McpServerInfo[] {
    const configured = this.deps.config.getMcpServers();
    const allNames = new Set<string>([
      ...Object.keys(configured),
      ...this.servers.keys(),
    ]);
    const statuses: McpServerInfo[] = [];
    for (const name of [...allNames].sort()) {
      const runtime = this.servers.get(name);
      const config = configured[name] ?? runtime?.config;
      const connection = runtime?.connection;
      statuses.push({
        name,
        status: runtime?.status ?? 'disconnected',
        toolCount: connection?.tools.length ?? 0,
        supportsPushNotifications:
          connection?.supportsPushNotifications ?? false,
        supportsRealtimeMedia: connection?.supportsRealtimeMedia ?? false,
        transport: config && 'command' in config ? 'stdio' : 'http',
      });
    }
    return statuses;
  }

  getToolCallHistory(): McpToolCallRecord[] {
    return [...this.toolCallHistory];
  }

  private addToolCallRecord(record: McpToolCallRecord): void {
    this.toolCallHistory.unshift(record);
    if (this.toolCallHistory.length > McpModule.MAX_TOOL_CALL_HISTORY) {
      this.toolCallHistory.length = McpModule.MAX_TOOL_CALL_HISTORY;
    }
  }
}

export function createMcp(deps: McpDependencies): Mcp {
  const localPresenter = new LocalBrowserOAuthPresenter();
  const coordinator = new LocalOAuthAuthorizationCoordinator((url) =>
    localPresenter.present(url),
  );
  const store = new McpOAuthStore(
    join(deps.dataDirectory ?? '.klex', 'credentials', 'mcp-oauth.json'),
  );
  const sessionFactory: OAuthAuthorizationSessionFactory = {
    start: async () => {
      const receiver = await LocalOAuthCallbackReceiver.start();
      return {
        redirectUrl: receiver.redirectUrl,
        authorize: (options) => coordinator.authorize({ ...options, receiver }),
        close: () => receiver.close(),
      };
    },
  };
  const connect: McpConnectionFactory = deps.connect
    ? deps.connect
    : (options) =>
        connectMcpServer({
          ...options,
          oauth: { sessionFactory, store },
        });
  return new McpModule({
    logger: deps.logging.child({
      name: 'mcp',
      bindings: { module: 'mcp' },
    }),
    config: deps.config,
    pushNotificationInbox: createInMemoryPushNotificationInbox(),
    realtimeMediaCapability: deps.realtimeMediaCapability,
    connect,
    cloudConnectivity: deps.cloudConnectivity,
    closeOAuth: () => coordinator.close(),
  });
}

function signature(config: McpServerConfig): string {
  return canonicalConfigSignature(config);
}

function safeDiagnosticError(error: unknown): {
  name: string;
  message: string;
} {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return {
    name,
    message: message
      .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
      .replace(
        /(["']?(?:authorization|access_token|client_assertion)["']?\s*[:=]\s*["']?)[^\s,"';]+/gi,
        '$1[REDACTED]',
      ),
  };
}

function abortableDelay(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
