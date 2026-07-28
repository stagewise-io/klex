import { randomUUID } from 'node:crypto';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import type {
  FluidEvent,
  FluidEventNotification,
} from '@stagewise/mcp-extension-fluid-events';

import type { Config, McpServerConfig } from '@/config';
import type { FluidEventInbox } from '@/fluid-event-inbox';
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
  type McpConnection,
  type McpConnectionFactory,
} from './connection';
import {
  buildMcpRegistry,
  canonicalConfigSignature,
  countMcpTools,
  type McpRegistry,
  normalizeCallToolResult,
} from './registry';

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const EVENT_PAGE_SIZE = 100;

export interface McpFluidEvent {
  namespace: string;
  event: FluidEvent;
}

export type McpFluidEventListener = (
  event: McpFluidEvent,
) => void | Promise<void>;

/**
 * Connection status of an MCP server.
 * - `connected` — connection is active and tools are available.
 * - `connecting` — a connection attempt is in progress.
 * - `error` — the connection failed and is awaiting retry.
 * - `disconnected` — the server is not configured or was removed.
 */
export type McpConnectionStatus =
  | 'connected'
  | 'connecting'
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
  /** Whether the server supports Fluid Events. */
  supportsFluidEvents: boolean;
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
  onFluidEvent(listener: McpFluidEventListener): () => void;
  close(): Promise<void>;

  /** Returns the current status of all configured MCP servers. */
  getServerStatuses(): McpServerInfo[];
  /** Returns the recorded history of tool calls to MCP servers. */
  getToolCallHistory(): McpToolCallRecord[];
}

export interface McpDependencies {
  logging: RootLogger;
  config: Config;
  fluidEventInbox: FluidEventInbox;
}

interface FluidEventWorker {
  connection: McpConnection;
  controller: AbortController;
  notifications: FluidEventNotification[];
  queue: Promise<void>;
  recovered: boolean;
}

class McpModule implements Mcp {
  private readonly connections = new Map<string, McpConnection>();
  private readonly signatures = new Map<string, string>();
  private readonly eventWorkers = new Map<string, FluidEventWorker>();
  private readonly eventListeners = new Set<McpFluidEventListener>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private registry: McpRegistry = new Map();
  private started = false;
  private generation = 0;
  private unsubscribe: (() => void) | undefined;
  private reconcileQueue: Promise<void> = Promise.resolve();
  private reconcileAbort: AbortController | undefined;

  /** Names of servers currently attempting to connect. */
  private readonly connectingServers = new Set<string>();
  /** Names of servers whose last connection attempt failed. */
  private readonly erroredServers = new Set<string>();
  /** Recorded tool call history (newest first). */
  private readonly toolCallHistory: McpToolCallRecord[] = [];
  /** Maximum number of tool call records to keep. */
  private static readonly MAX_TOOL_CALL_HISTORY = 500;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      config: Config;
      fluidEventInbox: FluidEventInbox;
      connect: McpConnectionFactory;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.deps.config.subscribe((config) => {
      this.clearRetries();
      this.scheduleReconcile(config.mcpServers);
    });
    this.scheduleReconcile(this.deps.config.getMcpServers());
    await this.reconcileQueue;
    this.deps.logger.info(
      {
        configuredServerCount: Object.keys(this.deps.config.getMcpServers())
          .length,
        connectedServerCount: this.connections.size,
        toolCount: countMcpTools(this.registry),
      },
      'MCP initial reconciliation completed',
    );
  }

  onFluidEvent(listener: McpFluidEventListener): () => void {
    this.eventListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.eventListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.reconcileAbort?.abort();
    this.clearRetries();
    for (const namespace of [...this.eventWorkers.keys()]) {
      this.stopEventWorker(namespace);
    }
    await this.reconcileQueue.catch(() => undefined);
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.signatures.clear();
    this.publishRegistry();
    await Promise.allSettled(
      connections.map((connection) => connection.close()),
    );
    this.connectingServers.clear();
    this.erroredServers.clear();
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
    const snapshot = structuredClone(servers);
    this.reconcileAbort?.abort();
    this.reconcileQueue = this.reconcileQueue
      .catch(() => undefined)
      .then(() => this.reconcile(snapshot))
      .catch((error: unknown) => {
        this.deps.logger.error({ error }, 'MCP reconciliation failed');
      });
  }

  private async reconcile(
    servers: Readonly<Record<string, McpServerConfig>>,
  ): Promise<void> {
    if (!this.started) return;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.reconcileAbort = controller;
    this.deps.logger.debug(
      { configuredServerCount: Object.keys(servers).length },
      'MCP reconciliation started',
    );

    for (const [namespace, connection] of [...this.connections]) {
      const next = servers[namespace];
      if (next && this.signatures.get(namespace) === signature(next)) continue;
      this.connections.delete(namespace);
      this.signatures.delete(namespace);
      this.stopEventWorker(namespace);
      this.erroredServers.delete(namespace);
      this.connectingServers.delete(namespace);
      const reason = next ? 'configuration-changed' : 'configuration-removed';
      await this.deps.fluidEventInbox.reset(namespace);
      await connection.close().catch((error: unknown) => {
        this.deps.logger.warn(
          { error, namespace },
          'MCP connection close failed',
        );
      });
      this.deps.logger.info({ namespace, reason }, 'MCP server disconnected');
    }
    this.publishRegistry();

    await Promise.all(
      Object.entries(servers).map(async ([namespace, config]) => {
        if (this.connections.has(namespace)) return;
        this.connectingServers.add(namespace);
        this.erroredServers.delete(namespace);
        try {
          const connection = await this.deps.connect({
            namespace,
            config,
            signal: controller.signal,
            onToolsChanged: (changed) => {
              if (this.connections.get(namespace) !== changed) return;
              this.publishRegistry();
              this.deps.logger.info(
                { namespace, toolCount: changed.tools.length },
                'MCP server tools updated',
              );
            },
            onFluidEvent: (changed, notification) =>
              this.enqueueFluidEvent(changed, notification),
            onDisconnect: (disconnected) => {
              if (this.connections.get(namespace) !== disconnected) return;
              this.connections.delete(namespace);
              this.signatures.delete(namespace);
              this.stopEventWorker(namespace);
              this.publishRegistry();
              this.deps.logger.warn(
                { namespace },
                'MCP server disconnected unexpectedly',
              );
              this.scheduleReconnect(namespace, config);
            },
          });
          if (!this.started || generation !== this.generation) {
            await connection.close();
            return;
          }
          this.connections.set(namespace, connection);
          this.signatures.set(namespace, signature(config));
          this.clearRetry(namespace);
          this.connectingServers.delete(namespace);
          this.erroredServers.delete(namespace);
          this.publishRegistry();
          if (connection.supportsFluidEvents) this.startEventWorker(connection);
          this.deps.logger.info(
            {
              namespace,
              toolCount: connection.tools.length,
              supportsFluidEvents: connection.supportsFluidEvents,
            },
            'MCP server connected',
          );
        } catch (error) {
          this.connectingServers.delete(namespace);
          if (!controller.signal.aborted) {
            this.erroredServers.add(namespace);
            this.deps.logger.error(
              { error, namespace },
              'MCP connection failed',
            );
            this.scheduleReconnect(namespace, config);
          }
        }
      }),
    );
    this.deps.logger.debug(
      {
        connectedServerCount: this.connections.size,
        toolCount: countMcpTools(this.registry),
      },
      'MCP reconciliation completed',
    );
  }

  private startEventWorker(connection: McpConnection): void {
    this.stopEventWorker(connection.namespace);
    const worker: FluidEventWorker = {
      connection,
      controller: new AbortController(),
      notifications: [],
      queue: Promise.resolve(),
      recovered: false,
    };
    this.eventWorkers.set(connection.namespace, worker);
    void this.runEventWorker(worker);
  }

  private async runEventWorker(worker: FluidEventWorker): Promise<void> {
    let attempt = 0;
    while (this.isCurrentWorker(worker)) {
      try {
        worker.recovered = false;
        const cursor = await this.deps.fluidEventInbox.readCursor(
          worker.connection.namespace,
        );
        const subscription = await worker.connection.fluidEvents.listen(
          cursor === undefined ? {} : { afterCursor: cursor },
          { request: { signal: worker.controller.signal } },
        );
        await this.recoverEvents(worker, cursor);
        worker.recovered = true;
        this.drainNotifications(worker);
        attempt = 0;
        await subscription.closed;
        await worker.queue;
        if (this.isCurrentWorker(worker)) {
          throw new Error('Fluid Events subscription closed');
        }
      } catch (error) {
        if (!this.isCurrentWorker(worker)) return;
        this.deps.logger.warn(
          { error, namespace: worker.connection.namespace },
          'Fluid Events subscription failed',
        );
        attempt += 1;
        await abortableDelay(
          Math.min(RETRY_INITIAL_MS * 2 ** (attempt - 1), RETRY_MAX_MS),
          worker.controller.signal,
        ).catch(() => undefined);
      }
    }
  }

  private async recoverEvents(
    worker: FluidEventWorker,
    initialCursor: string | undefined,
  ): Promise<void> {
    let cursor = initialCursor;
    while (this.isCurrentWorker(worker)) {
      const page = await worker.connection.fluidEvents.getEvents(
        {
          ...(cursor === undefined ? {} : { cursor }),
          limit: EVENT_PAGE_SIZE,
        },
        { request: { signal: worker.controller.signal } },
      );
      await this.commitEvents(
        worker,
        page.events,
        page.nextCursor,
        page.events.map((event) => event.eventId),
      );
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
  }

  private enqueueFluidEvent(
    connection: McpConnection,
    notification: FluidEventNotification,
  ): void {
    const worker = this.eventWorkers.get(connection.namespace);
    if (!worker || worker.connection !== connection) return;
    worker.notifications.push(notification);
    if (worker.recovered) this.drainNotifications(worker);
  }

  private drainNotifications(worker: FluidEventWorker): void {
    const notifications = worker.notifications.splice(0);
    for (const notification of notifications) {
      worker.queue = worker.queue
        .then(() =>
          this.commitEvents(
            worker,
            [notification.params.event],
            notification.params.cursor,
            [notification.params.event.eventId],
          ),
        )
        .catch((error: unknown) => {
          if (this.isCurrentWorker(worker))
            this.deps.logger.error(
              { error, namespace: worker.connection.namespace },
              'Fluid Event ingestion failed',
            );
        });
    }
  }

  private async commitEvents(
    worker: FluidEventWorker,
    events: readonly FluidEvent[],
    nextCursor: string,
    eventIds: string[],
  ): Promise<void> {
    if (!this.isCurrentWorker(worker)) return;
    const accepted = await this.deps.fluidEventInbox.commit(
      worker.connection.namespace,
      events,
      nextCursor,
    );
    for (const event of accepted) await this.publishFluidEvent(worker, event);
    if (eventIds.length > 0) {
      await this.acknowledgeEvents(worker, eventIds);
    }
  }

  private async acknowledgeEvents(
    worker: FluidEventWorker,
    eventIds: string[],
  ): Promise<void> {
    let attempt = 0;
    while (this.isCurrentWorker(worker)) {
      try {
        await worker.connection.fluidEvents.acknowledgeEvents(
          { eventIds },
          { request: { signal: worker.controller.signal } },
        );
        return;
      } catch (error) {
        if (!this.isCurrentWorker(worker)) return;
        attempt += 1;
        this.deps.logger.warn(
          { error, eventIds, namespace: worker.connection.namespace },
          'Fluid Event acknowledgement failed',
        );
        await abortableDelay(
          Math.min(RETRY_INITIAL_MS * 2 ** (attempt - 1), RETRY_MAX_MS),
          worker.controller.signal,
        ).catch(() => undefined);
      }
    }
  }

  private async publishFluidEvent(
    worker: FluidEventWorker,
    event: FluidEvent,
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
            'MCP Fluid Event listener failed',
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

  private isCurrentWorker(worker: FluidEventWorker): boolean {
    return (
      this.started &&
      !worker.controller.signal.aborted &&
      this.connections.get(worker.connection.namespace) === worker.connection &&
      this.eventWorkers.get(worker.connection.namespace) === worker
    );
  }

  private scheduleReconnect(namespace: string, config: McpServerConfig): void {
    if (!this.started || this.retryTimers.has(namespace)) return;
    const current = this.deps.config.getMcpServers()[namespace];
    if (!current || signature(current) !== signature(config)) return;
    const attempt = (this.retryAttempts.get(namespace) ?? 0) + 1;
    this.retryAttempts.set(namespace, attempt);
    const delay = Math.min(RETRY_INITIAL_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.retryTimers.delete(namespace);
      if (!this.started || this.connections.has(namespace)) return;
      this.scheduleReconcile(this.deps.config.getMcpServers());
    }, delay);
    timer.unref?.();
    this.retryTimers.set(namespace, timer);
  }

  private clearRetry(namespace: string): void {
    const timer = this.retryTimers.get(namespace);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(namespace);
    this.retryAttempts.delete(namespace);
    this.erroredServers.delete(namespace);
  }

  private clearRetries(): void {
    for (const namespace of [...this.retryTimers.keys()]) {
      this.clearRetry(namespace);
    }
  }

  private publishRegistry(): void {
    this.registry = buildMcpRegistry(this.connections);
  }

  getServerStatuses(): McpServerInfo[] {
    const configured = this.deps.config.getMcpServers();
    const allNames = new Set<string>([
      ...Object.keys(configured),
      ...this.connections.keys(),
      ...this.connectingServers,
      ...this.erroredServers,
    ]);
    const statuses: McpServerInfo[] = [];
    for (const name of [...allNames].sort()) {
      const connection = this.connections.get(name);
      const config = configured[name];
      const transport: 'stdio' | 'http' = config
        ? 'command' in config
          ? 'stdio'
          : 'http'
        : this.connections.has(name)
          ? 'http'
          : 'http';
      let status: McpConnectionStatus;
      if (connection) {
        status = 'connected';
      } else if (this.connectingServers.has(name)) {
        status = 'connecting';
      } else if (this.erroredServers.has(name)) {
        status = 'error';
      } else if (config) {
        status = 'connecting';
      } else {
        status = 'disconnected';
      }
      statuses.push({
        name,
        status,
        toolCount: connection ? connection.tools.length : 0,
        supportsFluidEvents: connection
          ? connection.supportsFluidEvents
          : false,
        transport,
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
  return new McpModule({
    logger: deps.logging.child({
      name: 'mcp',
      bindings: { module: 'mcp' },
    }),
    config: deps.config,
    fluidEventInbox: deps.fluidEventInbox,
    connect: connectMcpServer,
  });
}

function signature(config: McpServerConfig): string {
  return canonicalConfigSignature(config);
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
