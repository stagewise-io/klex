import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config, McpServerConfig } from '@/config';
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

export interface Mcp extends ToolProvider {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface McpDependencies {
  logging: RootLogger;
  config: Config;
}

class McpModule implements Mcp {
  private readonly connections = new Map<string, McpConnection>();
  private readonly signatures = new Map<string, string>();
  private registry: McpRegistry = new Map();
  private started = false;
  private generation = 0;
  private unsubscribe: (() => void) | undefined;
  private reconcileQueue: Promise<void> = Promise.resolve();
  private reconcileAbort: AbortController | undefined;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      config: Config;
      connect: McpConnectionFactory;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.deps.config.subscribe((config) => {
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

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.reconcileAbort?.abort();
    await this.reconcileQueue.catch(() => undefined);
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.signatures.clear();
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
    const result = await connection.invoke(tool, input, context.signal);
    return normalizeCallToolResult(result);
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
      const reason = next ? 'configuration-changed' : 'configuration-removed';
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
              this.deps.logger.debug(
                {
                  namespace,
                  tools: changed.tools.map((tool) => tool.name),
                },
                'MCP server tool names updated',
              );
            },
            onDisconnect: (disconnected) => {
              if (this.connections.get(namespace) !== disconnected) return;
              this.connections.delete(namespace);
              this.signatures.delete(namespace);
              this.publishRegistry();
              this.deps.logger.warn(
                { namespace },
                'MCP server disconnected unexpectedly',
              );
            },
          });
          if (!this.started || generation !== this.generation) {
            await connection.close();
            return;
          }
          this.connections.set(namespace, connection);
          this.signatures.set(namespace, signature(config));
          this.publishRegistry();
          this.deps.logger.info(
            {
              namespace,
              toolCount: connection.tools.length,
              supportsFluidEvents: connection.supportsFluidEvents,
            },
            'MCP server connected',
          );
          this.deps.logger.debug(
            {
              namespace,
              tools: connection.tools.map((tool) => tool.name),
            },
            'MCP server tool names discovered',
          );
        } catch (error) {
          if (!controller.signal.aborted)
            this.deps.logger.error(
              { error, namespace },
              'MCP connection failed',
            );
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

  private publishRegistry(): void {
    this.registry = buildMcpRegistry(this.connections);
  }
}

export function createMcp(deps: McpDependencies): Mcp {
  return new McpModule({
    logger: deps.logging.child({
      name: 'mcp',
      bindings: { module: 'mcp' },
    }),
    config: deps.config,
    connect: connectMcpServer,
  });
}

function signature(config: McpServerConfig): string {
  return canonicalConfigSignature(config);
}
