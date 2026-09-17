import {
  type ReadResourceResult,
  ResourceNotFoundError,
} from '@modelcontextprotocol/client';
import type { ToolSet } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { Mcp, McpPushNotification } from '@/mcp';
import type { ChatSessionInbox } from '@/session/chat/inbox';
import { SessionInboxUrgency } from '@/session/chat/inbox';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type {
  ContextDataUIPart,
  ContextMetadataValue,
  SessionInboxEvent,
} from '@/session/inbox';

import type {
  Extension,
  ExtensionFactory,
  HistoryProcessingResult,
  ProvisionalStepContext,
  ResolvedModel,
} from '../extension-api';
import { createDataPart, dataPartTransformer } from '../extension-api';
import { boundInboxEvent } from './inbox-helpers';
import {
  diffOpenResources,
  latestOpenResourcesPart,
  OPEN_RESOURCES_KEY,
  type OpenResourcesData,
  renderOpenResourcesData,
  toOpenResourcesEntry,
} from './open-resources-tracker';
import { mcpPushNotificationToInboxEvent } from './push-notification-adapter';
import {
  formatResourceList,
  hasUnexpandedUriTemplateExpression,
  pageResourceCatalog,
  parseCatalogCursor,
  type ResourceCatalog,
} from './resource-catalog';
import {
  type ContextDataContent,
  createResourceSnapshot,
  deletedResource,
  diffResource,
  formatInitialContent,
  MAX_RESOURCE_BINARY_BYTES,
  type ResourceDiffResult,
  type ResourceSnapshot,
  type ResourceStateData,
  renderResourceState,
} from './resource-handlers';
import {
  DEFAULT_RESOURCE_WINDOW_CONFIG,
  type ResourceWindowConfig,
  ResourceWindowManager,
  type ResourceWindowUpdateOutcome,
} from './resource-window-manager';
import {
  diffServerLists,
  latestServerListPart,
  renderServerListData,
  SERVER_LIST_KEY,
  type ServerListData,
  toServerListEntry,
} from './server-list-tracker';
import { getSystemPromptPart as systemPromptPartGetter } from './system-prompt-part';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WATCHER_SOURCE_ENV = 'mcp-resource-watcher';

type ResourceStatePart = {
  type: 'data-mcp-resource-state';
  data: ResourceStateData;
};

function isResourceStatePart(part: unknown): part is ResourceStatePart {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'data-mcp-resource-state' &&
    typeof (part as { data?: unknown }).data === 'object'
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

class McpIngressExtension implements Extension {
  private readonly resourceWindowManager: ResourceWindowManager;
  /** Unsubscribe function for the MCP resource-updated listener. */
  private unsubscribeResourceUpdated: (() => void) | undefined;
  /** Unsubscribe function for the MCP push-notification listener. */
  private unsubscribePushNotification: (() => void) | undefined;
  /** Fully aggregated resource catalog per server, refreshed explicitly. */
  private readonly resourceListCache = new Map<string, ResourceCatalog>();
  private readonly resourceListGenerations = new Map<string, number>();
  private readonly resourceListLoads = new Map<
    string,
    { generation: number; promise: Promise<ResourceCatalog> }
  >();
  private readonly activeSubscriptionLeases = new Set<string>();
  private readonly pendingSubscriptionLeases = new Map<string, Promise<void>>();
  private readonly pendingSubscriptionReleases = new Set<Promise<void>>();
  private readonly initializingResources = new Map<
    string,
    { count: number; updatePending: boolean }
  >();
  private readonly maxConcurrentWindows: number;

  constructor(
    private readonly deps: {
      mcp: Mcp;
      logger: ModuleLogger;
      inbox: ChatSessionInbox;
      getHistory: () => ExtendedUIMessage[];
    },
    config: McpIngressConfig,
  ) {
    this.maxConcurrentWindows = config.maxConcurrentWindows;
    const windowConfig: ResourceWindowConfig = {
      ...DEFAULT_RESOURCE_WINDOW_CONFIG,
      maxConcurrentWindows: config.maxConcurrentWindows,
    };
    this.resourceWindowManager = new ResourceWindowManager({
      config: windowConfig,
      logger: deps.logger,
      onUnsubscribe: (namespace, uri) => {
        this.trackSubscriptionRelease(namespace, uri);
      },
      onUpdateFired: (handle, generation, namespace, uri, oldSnapshot) =>
        this.handleUpdateFired(handle, generation, namespace, uri, oldSnapshot),
    });
  }

  async onStart(): Promise<void> {
    if (this.unsubscribeResourceUpdated) return;
    this.deps.logger.info('MCP Ingress extension started');
    this.unsubscribeResourceUpdated = this.deps.mcp.onResourceUpdated(
      (event) => {
        const initialization = this.initializingResources.get(
          watchKey(event.namespace, event.uri),
        );
        if (initialization) initialization.updatePending = true;
        this.resourceWindowManager.onResourceUpdate(event.namespace, event.uri);
      },
    );
    this.unsubscribePushNotification = this.deps.mcp.onPushNotification(
      (ev: McpPushNotification) => this.handlePushNotification(ev),
    );
  }

  async onClose(): Promise<void> {
    this.unsubscribeResourceUpdated?.();
    this.unsubscribeResourceUpdated = undefined;
    this.unsubscribePushNotification?.();
    this.unsubscribePushNotification = undefined;
    this.resourceWindowManager.stopAll();
    // Drain pending acquisitions: any that complete will add to
    // activeSubscriptionLeases and need to be released below.
    await Promise.allSettled([...this.pendingSubscriptionLeases.values()]);
    this.pendingSubscriptionLeases.clear();
    // Release any subscriptions that became active during shutdown.
    for (const key of [...this.activeSubscriptionLeases]) {
      const sep = key.indexOf('\0');
      this.trackSubscriptionRelease(key.slice(0, sep), key.slice(sep + 1));
    }
    await Promise.all([...this.pendingSubscriptionReleases]);
    for (const serverName of this.resourceListLoads.keys()) {
      this.resourceListGenerations.set(
        serverName,
        (this.resourceListGenerations.get(serverName) ?? 0) + 1,
      );
    }
    this.resourceListCache.clear();
    this.resourceListLoads.clear();
  }

  getSystemPromptPart = () => systemPromptPartGetter(this.maxConcurrentWindows);

  getTools(_model: ResolvedModel): ToolSet {
    return {
      listResources: {
        description: 'List resources and resource templates of MCP server.',
        inputSchema: z.object({
          serverName: z.string().min(1),
          cursor: z
            .string()
            .optional()
            .describe('Optional. 1-based index for pagination.'),
          refresh: z
            .boolean()
            .optional()
            .describe(
              'Bypass the cache and force-fetch a fresh catalog from the server.',
            ),
        }),
        execute: async ({ serverName, cursor, refresh }) => {
          try {
            if (refresh) {
              this.resourceListCache.delete(serverName);
              this.resourceListGenerations.set(
                serverName,
                (this.resourceListGenerations.get(serverName) ?? 0) + 1,
              );
            }
            const catalog = await this.getResourceCatalog(serverName);
            const offset = parseCatalogCursor(cursor);
            return {
              result: formatResourceList(
                serverName,
                pageResourceCatalog(catalog, offset),
              ),
            };
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
        description: 'Open MCP resource',
        inputSchema: z.object({
          serverName: z.string().min(1),
          uri: z.string().min(1),
          navigateHandle: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Handle of an existing window to navigate to this URI. If the handle does not exist, a new window is opened instead.',
            ),
        }),
        execute: async ({ serverName, uri, navigateHandle }) => {
          try {
            // If navigateHandle is provided, check if it exists.
            // If it doesn't exist, ignore it and open a new window.
            const validHandle = navigateHandle
              ? this.resourceWindowManager.getWindow(navigateHandle)
              : undefined;
            const existingWindow = navigateHandle
              ? validHandle
              : this.resourceWindowManager.findWindowByResource(
                  serverName,
                  uri,
                );
            const destinationOwner =
              this.resourceWindowManager.findWindowByResource(serverName, uri);
            if (
              navigateHandle &&
              validHandle &&
              destinationOwner &&
              destinationOwner.handle !== navigateHandle
            ) {
              return {
                result: `Failed to open resource: '${uri}' on server '${serverName}' is already open as '${destinationOwner.handle}'.`,
              };
            }
            if (hasUnexpandedUriTemplateExpression(uri)) {
              throw new Error(
                'URI contains unexpanded template variables; replace every curly-braced expression with a concrete value',
              );
            }
            // Reject new windows at capacity — navigating an existing handle is fine.
            if (
              !existingWindow &&
              this.resourceWindowManager.getOpenWindows().length >=
                this.maxConcurrentWindows
            ) {
              return {
                result: `Resource window limit reached (${this.maxConcurrentWindows}). Close an existing window with closeResource before opening another.`,
              };
            }
            let live = false;
            let initializing = false;
            let windowOpened = false;

            if (this.deps.mcp.supportsResourceSubscription(serverName)) {
              this.beginResourceInitialization(serverName, uri);
              initializing = true;
              try {
                await this.acquireSubscriptionLease(serverName, uri);
                live = true;
              } catch {
                // Subscription failure is silent in the tool response.
                // The open-resources list will show live: no for this window.
              }
            }

            try {
              const result = await this.deps.mcp.readResource(serverName, uri);
              const snapshot = createResourceSnapshot(uri, result);

              const window = this.resourceWindowManager.openWindow(
                serverName,
                uri,
                snapshot,
                {
                  ...(existingWindow ? { handle: existingWindow.handle } : {}),
                  live,
                },
              );
              windowOpened = true;
              return {
                result: `Opened in ${window.handle}`,
              };
            } finally {
              if (initializing) {
                const { last, updatePending } =
                  this.finishResourceInitialization(serverName, uri);
                if (windowOpened && live && updatePending) {
                  this.resourceWindowManager.onResourceUpdate(serverName, uri);
                } else if (
                  !windowOpened &&
                  live &&
                  last &&
                  !this.resourceWindowManager.findWindowByResource(
                    serverName,
                    uri,
                  )
                ) {
                  await this.releaseSubscriptionLease(serverName, uri);
                }
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              result: `Failed to read resource '${uri}' from server '${serverName}': ${message}`,
            };
          }
        },
      },
      closeResource: {
        description:
          'Close a resource window and stop receiving live updates for that resource. The handle becomes invalid after closing.',
        inputSchema: z.object({
          handle: z
            .string()
            .min(1)
            .describe(
              'Handle of the resource window to close, as returned by openResource.',
            ),
        }),
        execute: async ({ handle }) => {
          const window = this.resourceWindowManager.getWindow(handle);
          if (!window) {
            return {
              result: `Failed to close resource: unknown handle '${handle}'.`,
            };
          }
          this.resourceWindowManager.closeWindow(handle);
          return {
            result: `Closed resource handle '${handle}' (${window.namespace}|${window.uri}).`,
          };
        },
      },
    } satisfies ToolSet;
  }

  // -- historyTransformer -------------------------------------------------

  historyTransformer(
    history: ExtendedUIMessage[],
    _model: ResolvedModel,
  ): HistoryProcessingResult {
    let transformed = false;

    for (const msg of history) {
      if (msg.role !== 'user') continue;

      const parts = msg.parts.map((part) => {
        if (
          part.type !== 'data-context' ||
          part.data.sourceEnv !== WATCHER_SOURCE_ENV
        ) {
          return part;
        }

        transformed = true;
        return createDataPart(
          'mcp-resource-state',
          this.contextToStateData(part.data),
        ) as unknown as ExtendedUIMessage['parts'][number];
      });

      if (
        transformed &&
        parts.some((part, index) => part !== msg.parts[index])
      ) {
        msg.parts = parts;
      }
    }

    // -- Post-compaction: inject last known server list and open resources ---
    const first = history[0];
    if (first) {
      const original = this.deps.getHistory();
      const cutoffIndex = original.findIndex(
        (message) => message.id === first.id,
      );
      if (cutoffIndex > 0) {
        const removed = original.slice(0, cutoffIndex);
        const syntheticParts: ExtendedUIMessage['parts'][number][] = [];

        const lastServerList = latestServerListPart(removed);
        if (lastServerList) {
          syntheticParts.push(
            createDataPart(SERVER_LIST_KEY, {
              isInitial: true,
              servers: lastServerList.servers,
            }) as unknown as ExtendedUIMessage['parts'][number],
          );
        }

        const lastOpenResources = latestOpenResourcesPart(removed);
        if (lastOpenResources) {
          syntheticParts.push(
            createDataPart(OPEN_RESOURCES_KEY, {
              isInitial: true,
              resources: lastOpenResources.resources,
            }) as unknown as ExtendedUIMessage['parts'][number],
          );
        }

        if (syntheticParts.length > 0) {
          history[0] = {
            ...first,
            parts: [...syntheticParts, ...first.parts],
          };
          transformed = true;
        }
      }
    }

    return transformed ? { history, flags: { hasCompacted: true } } : history;
  }

  // -- dataPartTransformer ------------------------------------------------

  dataPartTransformers = {
    'mcp-resource-state': dataPartTransformer<ResourceStateData>((data) =>
      renderResourceState(data),
    ),
    [SERVER_LIST_KEY]: dataPartTransformer<ServerListData>((data) =>
      renderServerListData(data),
    ),
    [OPEN_RESOURCES_KEY]: dataPartTransformer<OpenResourcesData>((data) =>
      renderOpenResourcesData(data),
    ),
  };

  // -- getProvisionalStepContext ------------------------------------------

  getProvisionalStepContext(
    history: readonly ExtendedUIMessage[],
    _model: ResolvedModel,
  ): ProvisionalStepContext {
    // A historical state is current only for the same handle generation and URI.
    const knownKeys = new Set<string>();
    for (const msg of history) {
      for (const part of msg.parts) {
        const unknownPart: unknown = part;
        if (
          isResourceStatePart(unknownPart) &&
          unknownPart.data.truncated !== true
        ) {
          knownKeys.add(
            resourceStateKey(
              unknownPart.data.handle,
              unknownPart.data.generation,
              unknownPart.data.uri,
            ),
          );
        }
      }
    }

    // Re-inject full current state after compression, navigation, or reopen.
    const windows = this.resourceWindowManager.getOpenWindows();
    const parts: ExtendedUIMessage['parts'] = [];

    for (const window of windows) {
      const key = resourceStateKey(
        window.handle,
        window.generation,
        window.uri,
      );
      if (knownKeys.has(key)) continue;

      const snapshot = this.resourceWindowManager.getSnapshot(window.handle);
      if (!snapshot) continue;

      const content = formatInitialContent(snapshot);
      const stateData: ResourceStateData = {
        handle: window.handle,
        generation: window.generation,
        namespace: window.namespace,
        uri: window.uri,
        mimeType: window.mimeType ?? undefined,
        isInitial: true,
        diff: { kind: 'full', reason: 'initial', content },
      };

      parts.push(
        createDataPart(
          'mcp-resource-state',
          stateData,
        ) as unknown as ExtendedUIMessage['parts'][number],
      );
    }

    // -- MCP server list: emit initial or diff part -------------------------
    const currentServers = this.deps.mcp
      .getServerStatuses()
      .map(toServerListEntry);
    const prevList = latestServerListPart(history);

    if (!prevList) {
      // No prior list in history — emit initial full list.
      parts.push(
        createDataPart(SERVER_LIST_KEY, {
          isInitial: true,
          servers: currentServers,
        }) as unknown as ExtendedUIMessage['parts'][number],
      );
    } else {
      const diff = diffServerLists(prevList.servers, currentServers);
      if (diff) {
        parts.push(
          createDataPart(SERVER_LIST_KEY, {
            isInitial: false,
            servers: currentServers,
            diff,
          }) as unknown as ExtendedUIMessage['parts'][number],
        );
      }
    }

    // -- Open resources list: emit initial or diff part ---------------------
    const currentOpenResources = this.resourceWindowManager
      .getOpenWindows()
      .sort((a, b) =>
        a.handle.localeCompare(b.handle, undefined, { numeric: true }),
      )
      .map(toOpenResourcesEntry);
    const prevOpenResources = latestOpenResourcesPart(history);

    if (!prevOpenResources) {
      // No prior list in history — emit initial full list.
      parts.push(
        createDataPart(OPEN_RESOURCES_KEY, {
          isInitial: true,
          resources: currentOpenResources,
        }) as unknown as ExtendedUIMessage['parts'][number],
      );
    } else {
      const openDiff = diffOpenResources(
        prevOpenResources.resources,
        currentOpenResources,
      );
      if (openDiff) {
        parts.push(
          createDataPart(OPEN_RESOURCES_KEY, {
            isInitial: false,
            resources: currentOpenResources,
            diff: openDiff,
          }) as unknown as ExtendedUIMessage['parts'][number],
        );
      }
    }

    return { parts };
  }

  // -- introspect ---------------------------------------------------------

  introspect(): Record<string, unknown> {
    const windows = this.resourceWindowManager.getOpenWindows();
    return {
      openWindowCount: windows.length,
      windows: windows.map((window) => ({
        handle: window.handle,
        generation: window.generation,
        namespace: window.namespace,
        uri: window.uri,
        mimeType: window.mimeType,
        live: window.live,
        lastUpdateAt: new Date(window.lastUpdateAt).toISOString(),
      })),
    };
  }

  // -- Internal: update pipeline ------------------------------------------

  /**
   * Called by the ResourceWindowManager when a debounced update fires.
   * Re-reads the resource, diffs it, resolves urgency, and sends to inbox.
   *
   * @returns An explicit synchronization outcome.
   */
  private async handleUpdateFired(
    handle: string,
    generation: number,
    namespace: string,
    uri: string,
    oldSnapshot: ResourceSnapshot,
  ): Promise<ResourceWindowUpdateOutcome> {
    let newResult: ReadResourceResult;
    try {
      newResult = await this.deps.mcp.readResource(namespace, uri);
    } catch (error) {
      if (!(error instanceof ResourceNotFoundError)) {
        this.deps.logger.warn(
          { error, namespace, uri },
          'Resource refresh failed; retaining watch for retry',
        );
        return { kind: 'retry' };
      }

      if (!this.isCurrentWindow(handle, generation, namespace, uri)) {
        return { kind: 'unchanged', snapshot: oldSnapshot };
      }
      const diffResult = deletedResource(uri, namespace);
      const urgency = DEFAULT_RESOURCE_WINDOW_CONFIG.priorityResolver(
        namespace,
        uri,
        oldSnapshot.mimeType,
        diffResult,
      );
      this.sendToInbox(
        handle,
        generation,
        namespace,
        uri,
        oldSnapshot.mimeType,
        diffResult,
        urgency,
      );
      return { kind: 'deleted' };
    }

    const newSnapshot = createResourceSnapshot(uri, newResult);
    if (!this.isCurrentWindow(handle, generation, namespace, uri)) {
      return { kind: 'unchanged', snapshot: oldSnapshot };
    }
    const diffResult = diffResource(oldSnapshot, newSnapshot);
    if (diffResult.kind === 'unchanged') {
      return { kind: 'unchanged', snapshot: newSnapshot };
    }

    const urgency = DEFAULT_RESOURCE_WINDOW_CONFIG.priorityResolver(
      namespace,
      uri,
      newSnapshot.mimeType,
      diffResult,
    );

    this.sendToInbox(
      handle,
      generation,
      namespace,
      uri,
      newSnapshot.mimeType,
      diffResult,
      urgency,
      diffResult.kind === 'full'
        ? undefined
        : formatInitialContent(newSnapshot),
    );
    return { kind: 'updated', snapshot: newSnapshot };
  }

  /**
   * Sends a resource update as a context event to the session inbox.
   */
  private sendToInbox(
    handle: string,
    generation: number,
    namespace: string,
    uri: string,
    mimeType: string | undefined,
    diffResult: ResourceDiffResult,
    urgency: SessionInboxUrgency = SessionInboxUrgency.Deferrable,
    currentContent?: ContextDataContent[],
  ): void {
    const metadata: Record<string, ContextMetadataValue> = {
      handle,
      generation,
      namespace,
      uri,
      mimeType: mimeType ?? null,
      diffKind: diffResult.kind,
      ...(currentContent ? { currentContent } : {}),
    };

    // Include diff-specific fields so the historyTransformer can reconstruct
    // the full diff result from the serializable inbox payload.
    if (diffResult.kind === 'full') {
      metadata.reason = diffResult.reason;
    } else if (diffResult.kind === 'text-diff') {
      metadata.patch = diffResult.patch;
      metadata.linesAdded = diffResult.linesAdded;
      metadata.linesRemoved = diffResult.linesRemoved;
    } else if (diffResult.kind === 'json-diff') {
      metadata.added = diffResult.added;
      metadata.updated = diffResult.updated;
      metadata.deleted = diffResult.deleted;
      metadata.summary = diffResult.summary;
    }

    try {
      const event = boundInboxEvent(
        {
          sourceEnv: WATCHER_SOURCE_ENV,
          urgency,
          context: {
            sourceEnv: WATCHER_SOURCE_ENV,
            metadata,
            content: diffResult.content,
          },
        },
        diffResult.content.some((content) => content.type === 'image')
          ? MAX_RESOURCE_BINARY_BYTES * 2
          : DEFAULT_RESOURCE_WINDOW_CONFIG.maxEventBytes,
      );
      this.deps.inbox.send(event);
    } catch (error: unknown) {
      this.deps.logger.error(
        { error, namespace, uri },
        'Failed to send resource update to inbox',
      );
    }
  }

  private isCurrentWindow(
    handle: string,
    generation: number,
    namespace: string,
    uri: string,
  ): boolean {
    const window = this.resourceWindowManager.getWindow(handle);
    return (
      window?.generation === generation &&
      window.namespace === namespace &&
      window.uri === uri
    );
  }

  // -- Internal: push notification handling -----------------------------

  /**
   * Handles an MCP push notification. If the notification carries a
   * `resourceLink` and the referenced resource is currently open:
   *
   * - Open + live → suppress (the resource subscription delivers updates)
   * - Open + not live → send a lightweight notice to the inbox
   *
   * Otherwise, convert the full push notification to an inbox event so the
   * agent can act on it.
   */
  private handlePushNotification(ev: McpPushNotification): void {
    const { event, namespace } = ev;
    const resourceUri = event.resourceLink?.uri;

    if (resourceUri) {
      const window = this.resourceWindowManager.findWindowByResource(
        namespace,
        resourceUri,
      );
      if (window) {
        if (window.live) {
          // Suppressed: the resource subscription pipeline delivers diffs.
          return;
        }
        // Resource is open but not live — send a lightweight notice.
        this.sendPushNotificationNotice(window.handle, namespace, resourceUri);
        return;
      }
    }

    // Passthrough: convert the full push notification to an inbox event.
    const inboxEvent = mcpPushNotificationToInboxEvent(ev);
    this.deps.inbox.send(inboxEvent);
  }

  /**
   * Sends a lightweight notice to the inbox indicating that a push
   * notification was received for a resource that is open but not watched.
   */
  private sendPushNotificationNotice(
    handle: string,
    namespace: string,
    uri: string,
  ): void {
    const metadata: Record<string, ContextMetadataValue> = {
      handle,
      namespace,
      uri,
      kind: 'push-notification-notice',
    };

    const content: ContextDataUIPart['content'] = [
      { type: 'text', text: `${handle} received update` },
    ];

    const event: SessionInboxEvent = {
      sourceEnv: WATCHER_SOURCE_ENV,
      urgency: SessionInboxUrgency.Deferrable,
      context: {
        sourceEnv: WATCHER_SOURCE_ENV,
        metadata,
        content,
      },
    };

    try {
      this.deps.inbox.send(event);
    } catch (error: unknown) {
      this.deps.logger.error(
        { error, namespace, uri, handle },
        'Failed to send push notification notice to inbox',
      );
    }
  }

  private beginResourceInitialization(namespace: string, uri: string): void {
    const key = watchKey(namespace, uri);
    const current = this.initializingResources.get(key);
    if (current) {
      current.count += 1;
      return;
    }
    this.initializingResources.set(key, { count: 1, updatePending: false });
  }

  private finishResourceInitialization(
    namespace: string,
    uri: string,
  ): { last: boolean; updatePending: boolean } {
    const key = watchKey(namespace, uri);
    const current = this.initializingResources.get(key);
    if (!current) return { last: true, updatePending: false };
    const updatePending = current.updatePending;
    current.count -= 1;
    if (current.count > 0) return { last: false, updatePending };
    this.initializingResources.delete(key);
    return { last: true, updatePending };
  }

  private async acquireSubscriptionLease(
    namespace: string,
    uri: string,
  ): Promise<void> {
    const key = watchKey(namespace, uri);
    if (this.activeSubscriptionLeases.has(key)) return;
    const pending = this.pendingSubscriptionLeases.get(key);
    if (pending) return pending;

    const acquisition = this.deps.mcp
      .subscribeResource(namespace, uri, AbortSignal.timeout(15_000))
      .then(() => {
        this.activeSubscriptionLeases.add(key);
      })
      .finally(() => {
        if (this.pendingSubscriptionLeases.get(key) === acquisition) {
          this.pendingSubscriptionLeases.delete(key);
        }
      });
    this.pendingSubscriptionLeases.set(key, acquisition);
    return acquisition;
  }

  private trackSubscriptionRelease(namespace: string, uri: string): void {
    const release = this.releaseSubscriptionLease(namespace, uri).finally(
      () => {
        this.pendingSubscriptionReleases.delete(release);
      },
    );
    this.pendingSubscriptionReleases.add(release);
  }

  private async releaseSubscriptionLease(
    namespace: string,
    uri: string,
  ): Promise<void> {
    const key = watchKey(namespace, uri);
    if (!this.activeSubscriptionLeases.delete(key)) return;
    try {
      await this.deps.mcp.unsubscribeResource(
        namespace,
        uri,
        AbortSignal.timeout(10_000),
      );
    } catch (error: unknown) {
      this.deps.logger.warn(
        { error, namespace, uri },
        'Failed to unsubscribe from resource',
      );
    }
  }

  private async getResourceCatalog(
    serverName: string,
  ): Promise<ResourceCatalog> {
    const cached = this.resourceListCache.get(serverName);
    if (cached) return cached;
    const generation = this.resourceListGenerations.get(serverName) ?? 0;
    const pending = this.resourceListLoads.get(serverName);
    if (pending?.generation === generation) return pending.promise;

    // Mcp.listResources aggregates every remote page when cursor is omitted.
    const promise = this.deps.mcp
      .listResources(serverName)
      .then((result) => {
        const catalog = {
          resources: result.resources,
          resourceTemplates: result.resourceTemplates,
        };
        if (
          (this.resourceListGenerations.get(serverName) ?? 0) === generation
        ) {
          this.resourceListCache.set(serverName, catalog);
        }
        return catalog;
      })
      .finally(() => {
        if (this.resourceListLoads.get(serverName)?.promise === promise) {
          this.resourceListLoads.delete(serverName);
        }
      });
    this.resourceListLoads.set(serverName, { generation, promise });
    return promise;
  }

  // -- Internal: rendering helpers ----------------------------------------

  /**
   * Converts a `data-context` part from the resource watcher into
   * `ResourceStateData` for a `data-mcp-resource-state` part.
   */
  private contextToStateData(contextPart: {
    sourceEnv: string;
    metadata: Record<string, unknown>;
    content: ContextDataContent[];
  }): ResourceStateData {
    const metadata = contextPart.metadata;
    const handle = metadata.handle as string;
    const generation = metadata.generation as number;
    const namespace = metadata.namespace as string;
    const uri = metadata.uri as string;
    const mimeType = metadata.mimeType as string | undefined;
    const diffKind = metadata.diffKind as string;

    const updateDiff = this.reconstructDiff(
      diffKind,
      contextPart.content,
      metadata,
    );

    return {
      handle,
      generation,
      namespace,
      uri,
      mimeType: mimeType ?? undefined,
      isInitial: false,
      ...(metadata.truncated === true ? { truncated: true } : {}),
      diff: updateDiff,
    };
  }

  /**
   * Reconstructs a `ResourceDiffResult` from inbox content + metadata.
   * This is necessary because the inbox only carries serializable content,
   * not the full diff result object.
   */
  private reconstructDiff(
    diffKind: string,
    content: ContextDataContent[],
    metadata: Record<string, unknown>,
  ): ResourceDiffResult {
    if (diffKind === 'full') {
      const reason = (metadata.reason as string) ?? 'significant-change';
      return {
        kind: 'full',
        reason: reason as
          | 'initial'
          | 'significant-change'
          | 'unsupported-mime'
          | 'deleted',
        content,
      };
    }
    if (diffKind === 'text-diff') {
      return {
        kind: 'text-diff',
        patch: (metadata.patch as string) ?? '',
        linesAdded: (metadata.linesAdded as number) ?? 0,
        linesRemoved: (metadata.linesRemoved as number) ?? 0,
        content,
      };
    }
    if (diffKind === 'json-diff') {
      return {
        kind: 'json-diff',
        added: (metadata.added as string[]) ?? [],
        updated:
          (metadata.updated as {
            key: string;
            oldValue: string;
            newValue: string;
          }[]) ?? [],
        deleted: (metadata.deleted as string[]) ?? [],
        summary: (metadata.summary as string) ?? '',
        content,
      };
    }
    // Fallback
    return { kind: 'full', reason: 'unsupported-mime', content };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function watchKey(namespace: string, uri: string): string {
  return `${namespace}\0${uri}`;
}

function resourceStateKey(
  handle: string,
  generation: number,
  uri: string,
): string {
  return `${handle}\0${generation}\0${uri}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface McpIngressConfig {
  /** Maximum number of concurrent resource windows per session. */
  maxConcurrentWindows: number;
}

export const DEFAULT_MCP_INGRESS_CONFIG: McpIngressConfig = {
  maxConcurrentWindows: 5,
};

/** Adds MCP resource discovery, reading, and live-updating windows to a session. */
export function createMcpIngressExt(
  config: McpIngressConfig = DEFAULT_MCP_INGRESS_CONFIG,
): ExtensionFactory {
  if (
    !Number.isFinite(config.maxConcurrentWindows) ||
    !Number.isInteger(config.maxConcurrentWindows) ||
    config.maxConcurrentWindows < 1
  ) {
    throw new Error('maxConcurrentWindows must be a positive integer.');
  }

  return {
    identifier: 'io.stagewise/mcp-ingress',
    displayName: 'MCP Ingress',
    create: (deps) => {
      if (!deps.mcp) {
        throw new Error(
          'mcp-ingress extension requires MCP access — cannot be loaded in sessions without MCP',
        );
      }
      return new McpIngressExtension(
        {
          mcp: deps.mcp,
          logger: deps.logger,
          inbox: deps.inbox,
          getHistory: deps.getHistory,
        },
        config,
      );
    },
  };
}
