import { AsyncLocalStorage } from 'node:async_hooks';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  createPushNotificationsHttpSubscriptionManager,
  hasPerRequestPushNotificationsCapability,
  type PushNotificationsHttpSubscriptionManager,
  registerPushNotificationsServer,
} from '@stagewise/mcp-extension-push-notifications';

import {
  FilesystemService,
  MachinePathResolver,
  SearchService,
} from './filesystem/index.js';
import { type MachineLogger, silentMachineLogger } from './logger.js';
import {
  createNotificationStore,
  type NotificationStore,
  shellExitedEvent,
  watcherCompletedEvent,
} from './notifications/index.js';
import { CommandService, ShellService } from './shell/index.js';
import { WatcherService } from './watchers/index.js';
import { WorkloadTracker } from './workloads/index.js';

const requestCapabilities = new AsyncLocalStorage<{
  pushNotifications: boolean;
}>();

export interface MachineMcpOptions {
  principalId?: string;
  notifications?: NotificationStore;
  logger?: MachineLogger;
}

export interface MachineMcp {
  /** Work that must keep the machine awake; feeds workload lease reporting. */
  readonly workloads: WorkloadTracker;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

class MachineMcpModule implements MachineMcp {
  readonly workloads: WorkloadTracker;
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #shell: ShellService;
  readonly #commands: CommandService;

  readonly #subscriptions: PushNotificationsHttpSubscriptionManager;
  readonly #watchers: WatcherService;
  readonly #store: NotificationStore;
  readonly #ownsStore: boolean;
  readonly #unsubscribe: () => void;
  readonly #shellTracking = new Set<string>();

  constructor(defaultCwd: string, options: MachineMcpOptions) {
    const paths = new MachinePathResolver(defaultCwd);
    const filesystem = new FilesystemService(paths);
    const search = new SearchService(paths);
    this.workloads = new WorkloadTracker();
    this.#commands = new CommandService(paths, this.workloads);
    const principalId = options.principalId ?? 'local';
    const logger = options.logger ?? silentMachineLogger;
    const store = options.notifications ?? createNotificationStore({ logger });
    this.#store = store;
    this.#ownsStore = !options.notifications;
    this.#shell = new ShellService(paths, undefined, this.workloads, {
      onExit: (info, output) => {
        if (!this.#shellTracking.delete(info.id)) return;
        void store
          .complete(
            `shell:${info.id}`,
            shellExitedEvent(
              {
                sessionId: info.id,
                shell: info.shell,
                cwd: info.cwd,
                createdAt: info.createdAt,
              },
              {
                exitCode: info.exitCode ?? null,
                signal: info.signal ?? null,
                exitedAt: new Date().toISOString(),
                output,
              },
            ),
          )
          .catch((error: unknown) =>
            logger.error({ error }, 'Shell exit notification failed'),
          );
      },
    });
    this.#watchers = new WatcherService(paths, {
      onStart: (info) =>
        store.track({
          id: `watcher:${info.id}`,
          principalId,
          kind: 'watcher',
          info,
        }),
      onFinish: (info, completion) =>
        store.complete(
          `watcher:${info.id}`,
          watcherCompletedEvent(info, completion),
        ),
      onCancel: (id) => store.forget(`watcher:${id}`),
      onError: (error) =>
        logger.error({ error }, 'Watcher notification failed'),
    });

    this.#handler = createMcpHandler(
      () => {
        const pushNotifications =
          requestCapabilities.getStore()?.pushNotifications === true;
        const server = new McpServer(
          { name: 'klex-machine', version: '0.1.0' },
          {
            capabilities: {},
            instructions: `UNRESTRICTED MACHINE ACCESS. Filesystem and shell operations run with the permissions of the server OS user. Relative paths resolve from ${defaultCwd}. Operating system: ${process.platform}.${pushNotifications ? ' Watcher outcomes and requested shell-exit notifications arrive as push notifications.' : ''}`,
          },
        );

        registerPushNotificationsServer(server.server, {
          getEvents: ({ limit }) => store.pending(principalId, limit),
          acknowledgeEvents: ({ eventIds }) =>
            store.acknowledge(principalId, eventIds),
        });
        if (pushNotifications) {
          server.registerTool(
            'createWatcher',
            {
              description:
                'Start a one-shot background watcher. Run a shell command that blocks until a condition holds and exits 0 (e.g. a polling loop with sleep). When it exits, fails, or reaches timeoutMs, the machine sends one push notification with the outcome and last output. Use instead of repeatedly polling with tool calls.',
              inputSchema: z.object({
                command: z.string().min(1).max(16384),
                title: z.string().min(1).max(200),
                timeoutMs: z.number().int().min(1000).max(604800000),
                cwd: z.string().min(1).optional(),
                env: z.record(z.string(), z.string()).optional(),
              }),
            },
            (input) => result(() => this.#watchers.create(input)),
          );
          server.registerTool(
            'listWatchers',
            {
              description:
                'List running and finished but unacknowledged watchers.',
              inputSchema: z.object({}),
            },
            () =>
              result(() => [
                ...this.#watchers.list(),
                ...store.records(principalId).flatMap((record) =>
                  record.kind === 'watcher' && record.state === 'pending'
                    ? [
                        {
                          ...record.info,
                          id: record.info.watcherId,
                          status:
                            record.event.type === 'watcher.lost'
                              ? 'lost'
                              : 'completed',
                          outcome: record.event.data?.outcome,
                        },
                      ]
                    : [],
                ),
              ]),
          );
          server.registerTool(
            'cancelWatcher',
            {
              description: 'Cancel a watcher without sending a notification.',
              inputSchema: z.object({ id: z.string().uuid() }),
            },
            ({ id }) =>
              result(async () => {
                if (this.#watchers.list().some((info) => info.id === id))
                  await this.#watchers.cancel(id);
                else if (
                  store
                    .records(principalId)
                    .some((record) => record.id === `watcher:${id}`)
                )
                  await store.forget(`watcher:${id}`);
                else throw new Error(`Unknown watcher: ${id}`);
              }),
          );
        }
        server.registerTool(
          'read',
          {
            description: 'Read a UTF-8 or base64 file. Access is unrestricted.',
            inputSchema: z.object({
              path: z.string().min(1),
              encoding: z.enum(['utf8', 'base64']).optional(),
              startLine: z.number().int().positive().optional(),
              endLine: z.number().int().positive().optional(),
            }),
          },
          (input) => result(() => filesystem.read(input)),
        );
        server.registerTool(
          'list',
          {
            description:
              'List a directory with metadata. Access is unrestricted.',
            inputSchema: z.object({ path: z.string().min(1) }),
          },
          ({ path }) => result(() => filesystem.list(path)),
        );
        server.registerTool(
          'write',
          {
            description: 'Atomically write a UTF-8 or base64 file.',
            inputSchema: z.object({
              path: z.string().min(1),
              content: z.string(),
              encoding: z.enum(['utf8', 'base64']).optional(),
            }),
          },
          (input) => result(() => filesystem.write(input)),
        );
        server.registerTool(
          'multiEdit',
          {
            description: 'Apply sequential exact text replacements atomically.',
            inputSchema: z.object({
              path: z.string().min(1),
              edits: z
                .array(
                  z.object({
                    oldString: z.string(),
                    newString: z.string(),
                    replaceAll: z.boolean().optional(),
                  }),
                )
                .min(1),
            }),
          },
          ({ path, edits }) => result(() => filesystem.multiEdit(path, edits)),
        );
        server.registerTool(
          'mkdir',
          {
            description: 'Recursively create a directory.',
            inputSchema: z.object({ path: z.string().min(1) }),
          },
          ({ path }) => result(() => filesystem.mkdir(path)),
        );
        server.registerTool(
          'delete',
          {
            description: 'Permanently delete a file or directory tree.',
            inputSchema: z.object({ path: z.string().min(1) }),
          },
          ({ path }) => result(() => filesystem.delete(path)),
        );
        server.registerTool(
          'copy',
          {
            description: 'Copy or move a file, symlink, or directory tree.',
            inputSchema: z.object({
              source: z.string().min(1),
              destination: z.string().min(1),
              move: z.boolean().optional(),
              overwrite: z.boolean().optional(),
            }),
          },
          (input) => result(() => filesystem.copy(input)),
        );
        server.registerTool(
          'glob',
          {
            description: 'Find paths using bounded glob patterns.',
            inputSchema: z.object({
              patterns: z.array(z.string().min(1)).min(1),
              cwd: z.string().min(1).optional(),
              exclude: z.array(z.string()).optional(),
              hidden: z.boolean().optional(),
              gitignore: z.boolean().optional(),
              limit: z.number().int().positive().optional(),
            }),
          },
          (input) => result(() => search.glob(input)),
        );
        server.registerTool(
          'grepSearch',
          {
            description:
              'Search bounded text files using a regular expression.',
            inputSchema: z.object({
              pattern: z.string().min(1),
              cwd: z.string().min(1).optional(),
              include: z.array(z.string()).optional(),
              exclude: z.array(z.string()).optional(),
              caseSensitive: z.boolean().optional(),
              hidden: z.boolean().optional(),
              gitignore: z.boolean().optional(),
              context: z.number().int().min(0).max(20).optional(),
              limit: z.number().int().positive().optional(),
            }),
          },
          (input) => result(() => search.grep(input)),
        );
        server.registerTool(
          'createShellSession',
          {
            description: 'Create an unrestricted persistent PTY shell session.',
            inputSchema: z.object({
              cwd: z.string().min(1).optional(),
              shell: z.string().min(1).optional(),
              args: z.array(z.string()).optional(),
              cols: z.number().int().positive().optional(),
              rows: z.number().int().positive().optional(),
              env: z.record(z.string(), z.string()).optional(),
              ...(pushNotifications
                ? { notifyOnExit: z.boolean().optional() }
                : {}),
            }),
          },
          (input) =>
            result(async () => {
              if (!pushNotifications || !input.notifyOnExit)
                return this.#shell.create(input);
              return this.#shell.createTracked(
                input,
                async (info) => {
                  await store.track({
                    id: `shell:${info.id}`,
                    principalId,
                    kind: 'shell',
                    info: {
                      sessionId: info.id,
                      shell: info.shell,
                      cwd: info.cwd,
                      createdAt: info.createdAt,
                    },
                  });
                  this.#shellTracking.add(info.id);
                },
                async (id) => {
                  this.#shellTracking.delete(id);
                  await store.forget(`shell:${id}`);
                },
              );
            }),
        );
        server.registerTool(
          'writeShellSession',
          {
            description: 'Write raw input to a persistent PTY session.',
            inputSchema: z.object({
              id: z.string().uuid(),
              data: z.string(),
            }),
          },
          ({ id, data }) => result(() => this.#shell.write(id, data)),
        );
        server.registerTool(
          'readShellSession',
          {
            description: 'Read PTY output using a monotonic cursor.',
            inputSchema: z.object({
              id: z.string().uuid(),
              cursor: z.number().int().min(0).optional(),
              waitMs: z.number().int().min(0).max(30_000).optional(),
            }),
          },
          (input) => result(() => this.#shell.read(input)),
        );
        server.registerTool(
          'resizeShellSession',
          {
            description: 'Resize a persistent PTY session.',
            inputSchema: z.object({
              id: z.string().uuid(),
              cols: z.number().int().positive(),
              rows: z.number().int().positive(),
            }),
          },
          ({ id, cols, rows }) =>
            result(() => this.#shell.resize(id, cols, rows)),
        );
        server.registerTool(
          'closeShellSession',
          {
            description: 'Terminate and remove a persistent PTY session.',
            inputSchema: z.object({ id: z.string().uuid() }),
          },
          ({ id }) =>
            result(async () => {
              this.#shell.close(id);
              this.#shellTracking.delete(id);
              await store.forget(`shell:${id}`);
            }),
        );
        server.registerTool(
          'listShellSessions',
          {
            description: 'List persistent PTY sessions and exit states.',
            inputSchema: z.object({}),
          },
          () => result(() => this.#shell.list()),
        );
        server.registerTool(
          'protectShellSession',
          {
            description:
              'Keep the machine awake for raw interactive PTY work for a bounded duration (1 s to 4 h). Repeat to extend; ends early on unprotect, exit or close. Prefer runCommand for finite commands.',
            inputSchema: z.object({
              id: z.string().uuid(),
              durationMs: z.number().int().min(1_000).max(14_400_000),
            }),
          },
          ({ id, durationMs }) =>
            result(() => this.#shell.protect(id, durationMs)),
        );
        server.registerTool(
          'unprotectShellSession',
          {
            description: 'End the bounded keep-awake protection of a PTY.',
            inputSchema: z.object({ id: z.string().uuid() }),
          },
          ({ id }) => result(() => this.#shell.unprotect(id)),
        );
        server.registerTool(
          'runCommand',
          {
            description:
              'Run a non-interactive shell command with tracked completion. foreground (default): finite work that keeps the machine awake until exit, even after this call returns; leftover processes are stopped on exit. detached: long-running servers or watchers that do not keep the machine awake. Returns after waitMs (default 10000) with output so far; continue with readCommand.',
            inputSchema: z.object({
              command: z.string().min(1),
              cwd: z.string().min(1).optional(),
              env: z.record(z.string(), z.string()).optional(),
              mode: z.enum(['foreground', 'detached']).optional(),
              shell: z.string().min(1).optional(),
              timeoutMs: z.number().int().positive().optional(),
              waitMs: z.number().int().min(0).max(30_000).optional(),
            }),
          },
          (input) => result(() => this.#commands.run(input)),
        );
        server.registerTool(
          'readCommand',
          {
            description:
              'Read command output by monotonic cursor, with status and exit state.',
            inputSchema: z.object({
              id: z.string().uuid(),
              cursor: z.number().int().min(0).optional(),
              waitMs: z.number().int().min(0).max(30_000).optional(),
            }),
          },
          (input) => result(() => this.#commands.read(input)),
        );
        server.registerTool(
          'cancelCommand',
          {
            description:
              'Stop a running command and its process group (SIGTERM, then SIGKILL after 5 s).',
            inputSchema: z.object({ id: z.string().uuid() }),
          },
          ({ id }) => result(() => this.#commands.cancel(id)),
        );
        server.registerTool(
          'listCommands',
          {
            description: 'List tracked commands and their states.',
            inputSchema: z.object({}),
          },
          () => result(() => this.#commands.list()),
        );
        return server;
      },
      { legacy: 'stateless' },
    );
    this.#subscriptions = createPushNotificationsHttpSubscriptionManager(
      (request) => this.#handler.fetch(request),
      { resolveConsumerKey: () => principalId },
    );
    this.#unsubscribe = store.onEvent(principalId, (event) =>
      this.#subscriptions.publish(principalId, { event }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    let pushNotifications = false;
    if (
      request.method === 'POST' &&
      request.headers.get('content-type')?.includes('application/json')
    ) {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      if (
        isRecord(body) &&
        isRecord(body.params) &&
        isRecord(body.params._meta)
      ) {
        const capability =
          body.params._meta['io.modelcontextprotocol/clientCapabilities'];
        if (isRecord(capability) && isRecord(capability.extensions)) {
          pushNotifications = hasPerRequestPushNotificationsCapability(
            body.params._meta,
          );
        }
      }
    }
    return requestCapabilities.run({ pushNotifications }, () =>
      this.#subscriptions.fetch(request),
    );
  }

  async close(): Promise<void> {
    this.#commands.closeAll();
    this.#unsubscribe();
    this.#subscriptions.close();
    try {
      const results = await Promise.allSettled([
        this.#watchers.closeAll(),
        this.#shell.closeAll(),
      ]);
      this.#shellTracking.clear();
      await this.#handler.close();
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } finally {
      this.workloads.close();
      if (this.#ownsStore) await this.#store.close();
    }
  }
}

export function createMachineMcp(
  defaultCwd: string,
  options: MachineMcpOptions = {},
): MachineMcp {
  return new MachineMcpModule(defaultCwd, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function result(operation: () => unknown | Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(value ?? { ok: true }) },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    };
  }
}
