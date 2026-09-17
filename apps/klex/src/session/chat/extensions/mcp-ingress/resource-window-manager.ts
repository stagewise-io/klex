import type { ModuleLogger } from '@stagewise/logger';

import { SessionInboxUrgency } from '@/session/chat/inbox';

import {
  normalizeMimeType,
  type ResourceDiffResult,
  type ResourceSnapshot,
} from './resource-handlers';

export type ResourcePriorityResolver = (
  namespace: string,
  uri: string,
  mimeType: string | undefined,
  diffResult: ResourceDiffResult,
) => SessionInboxUrgency;

export interface ResourceWindowConfig {
  imageDebounceMs: number;
  textDebounceMs: number;
  jsonDebounceMs: number;
  defaultDebounceMs: number;
  maxConcurrentWindows: number;
  maxEventBytes: number;
  maxEventsPerWindow: number;
  rateLimitWindowMs: number;
  priorityResolver: ResourcePriorityResolver;
}

export const DEFAULT_RESOURCE_WINDOW_CONFIG: ResourceWindowConfig = {
  imageDebounceMs: 5_000,
  textDebounceMs: 2_000,
  jsonDebounceMs: 1_000,
  defaultDebounceMs: 3_000,
  maxConcurrentWindows: 5,
  maxEventBytes: 50_000,
  maxEventsPerWindow: 10,
  rateLimitWindowMs: 30_000,
  priorityResolver: defaultPriorityResolver,
};

function defaultPriorityResolver(
  _namespace: string,
  _uri: string,
  _mimeType: string | undefined,
  diffResult: ResourceDiffResult,
): SessionInboxUrgency {
  if (diffResult.kind === 'full') {
    if (
      diffResult.reason === 'deleted' ||
      diffResult.reason === 'significant-change'
    )
      return SessionInboxUrgency.Default;
    return SessionInboxUrgency.Deferrable;
  }
  return SessionInboxUrgency.Deferrable;
}

export interface ResourceWindow {
  handle: string;
  generation: number;
  namespace: string;
  uri: string;
  mimeType: string | undefined;
  live: boolean;
  lastUpdateAt: number;
}

export type ResourceWindowUpdateOutcome =
  | { kind: 'updated'; snapshot: ResourceSnapshot }
  | { kind: 'unchanged'; snapshot: ResourceSnapshot }
  | { kind: 'deleted' }
  | { kind: 'retry'; retryAfterMs?: number };

export interface ResourceWindowManagerDeps {
  config: ResourceWindowConfig;
  logger: ModuleLogger;
  onUnsubscribe: (namespace: string, uri: string) => void;
  onUpdateFired: (
    handle: string,
    generation: number,
    namespace: string,
    uri: string,
    oldSnapshot: ResourceSnapshot,
  ) => Promise<ResourceWindowUpdateOutcome>;
}

interface ResourceWindowEntry extends ResourceWindow {
  snapshot: ResourceSnapshot;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  pendingUpdate: boolean;
  updateInFlight: boolean;
  rateLimitTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryCount: number;
}

function resourceKey(namespace: string, uri: string): string {
  return `${namespace}\0${uri}`;
}

export class ResourceWindowManager {
  private readonly windows = new Map<string, ResourceWindowEntry>();
  private nextHandleNumber = 1;
  private eventsInWindow = 0;
  private windowStart = Date.now();

  constructor(private readonly deps: ResourceWindowManagerDeps) {}

  openWindow(
    namespace: string,
    uri: string,
    snapshot: ResourceSnapshot,
    options: { handle?: string; live: boolean },
  ): ResourceWindow {
    const destinationOwner = this.findWindowByResource(namespace, uri);
    let existing: ResourceWindowEntry | undefined;

    if (options.handle) {
      existing = this.windows.get(options.handle);
      if (!existing)
        throw new Error(`Unknown resource handle '${options.handle}'`);
      if (destinationOwner && destinationOwner.handle !== options.handle) {
        throw new Error(
          `Resource '${uri}' on server '${namespace}' is already open as '${destinationOwner.handle}'`,
        );
      }
    } else {
      existing = destinationOwner
        ? this.windows.get(destinationOwner.handle)
        : undefined;
    }

    if (
      !existing &&
      this.windows.size >= this.deps.config.maxConcurrentWindows
    ) {
      throw new Error(
        `Resource window limit reached (${this.deps.config.maxConcurrentWindows}). Close an existing window before opening another.`,
      );
    }

    const handle = existing?.handle ?? `r${this.nextHandleNumber++}`;
    const generation = (existing?.generation ?? 0) + 1;
    const entry: ResourceWindowEntry = {
      handle,
      generation,
      namespace,
      uri,
      snapshot,
      mimeType: normalizeMimeType(snapshot.mimeType),
      live: options.live,
      lastUpdateAt: Date.now(),
      debounceTimer: undefined,
      pendingUpdate: false,
      updateInFlight: false,
      rateLimitTimer: undefined,
      retryTimer: undefined,
      retryCount: 0,
    };

    if (existing) this.clearScheduledWork(existing);
    this.windows.set(handle, entry);

    if (
      existing?.live &&
      (!options.live ||
        resourceKey(existing.namespace, existing.uri) !==
          resourceKey(namespace, uri))
    ) {
      this.deps.onUnsubscribe(existing.namespace, existing.uri);
    }

    return this.toPublicWindow(entry);
  }

  closeWindow(handle: string): boolean {
    const entry = this.windows.get(handle);
    if (!entry) return false;
    this.stopWindowEntry(entry);
    return true;
  }

  stopAll(): void {
    for (const entry of [...this.windows.values()]) {
      this.stopWindowEntry(entry);
    }
  }

  getWindow(handle: string): ResourceWindow | undefined {
    const entry = this.windows.get(handle);
    return entry ? this.toPublicWindow(entry) : undefined;
  }

  findWindowByResource(
    namespace: string,
    uri: string,
  ): ResourceWindow | undefined {
    for (const entry of this.windows.values()) {
      if (entry.namespace === namespace && entry.uri === uri) {
        return this.toPublicWindow(entry);
      }
    }
    return undefined;
  }

  getOpenWindows(): ResourceWindow[] {
    return [...this.windows.values()].map((entry) =>
      this.toPublicWindow(entry),
    );
  }

  getSnapshot(handle: string): ResourceSnapshot | undefined {
    return this.windows.get(handle)?.snapshot;
  }

  onResourceUpdate(namespace: string, uri: string): void {
    for (const entry of this.windows.values()) {
      if (!entry.live || entry.namespace !== namespace || entry.uri !== uri)
        continue;
      entry.pendingUpdate = true;
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
      }
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = undefined;
        if (!entry.pendingUpdate) return;
        void this.fireUpdate(entry);
      }, this.getDebounceMs(entry.mimeType));
    }
  }

  private async fireUpdate(entry: ResourceWindowEntry): Promise<void> {
    if (this.windows.get(entry.handle) !== entry || !entry.live) return;
    if (entry.updateInFlight) {
      entry.pendingUpdate = true;
      return;
    }

    this.maybeResetWindow();
    if (this.eventsInWindow >= this.deps.config.maxEventsPerWindow) {
      if (!entry.rateLimitTimer) {
        const delay = Math.max(
          1,
          this.deps.config.rateLimitWindowMs - (Date.now() - this.windowStart),
        );
        entry.rateLimitTimer = setTimeout(() => {
          entry.rateLimitTimer = undefined;
          void this.fireUpdate(entry);
        }, delay);
      }
      this.deps.logger.debug(
        { handle: entry.handle, namespace: entry.namespace, uri: entry.uri },
        'Resource refresh delayed by rate limit',
      );
      return;
    }

    entry.pendingUpdate = false;
    entry.updateInFlight = true;
    this.eventsInWindow++;

    try {
      const outcome = await this.deps.onUpdateFired(
        entry.handle,
        entry.generation,
        entry.namespace,
        entry.uri,
        entry.snapshot,
      );
      if (this.windows.get(entry.handle) !== entry) return;

      if (outcome.kind === 'deleted') {
        this.stopWindowEntry(entry);
        return;
      }
      if (outcome.kind === 'retry') {
        entry.pendingUpdate = true;
        const retryAfterMs =
          outcome.retryAfterMs ??
          Math.min(30_000, 1_000 * 2 ** entry.retryCount);
        entry.retryCount++;
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = undefined;
          void this.fireUpdate(entry);
        }, retryAfterMs);
        return;
      }

      entry.retryCount = 0;
      entry.snapshot = outcome.snapshot;
      entry.mimeType = normalizeMimeType(outcome.snapshot.mimeType);
      entry.lastUpdateAt = Date.now();
    } catch (error: unknown) {
      this.deps.logger.error(
        {
          error,
          handle: entry.handle,
          namespace: entry.namespace,
          uri: entry.uri,
        },
        'Resource update fired callback failed',
      );
    } finally {
      entry.updateInFlight = false;
      if (
        this.windows.get(entry.handle) === entry &&
        entry.pendingUpdate &&
        !entry.retryTimer
      ) {
        void this.fireUpdate(entry);
      }
    }
  }

  private getDebounceMs(mimeType: string | undefined): number {
    if (!mimeType) return this.deps.config.defaultDebounceMs;
    if (mimeType.startsWith('image/')) return this.deps.config.imageDebounceMs;
    if (mimeType === 'application/json') return this.deps.config.jsonDebounceMs;
    if (mimeType.startsWith('text/')) return this.deps.config.textDebounceMs;
    return this.deps.config.defaultDebounceMs;
  }

  private maybeResetWindow(): void {
    const now = Date.now();
    if (now - this.windowStart >= this.deps.config.rateLimitWindowMs) {
      this.windowStart = now;
      this.eventsInWindow = 0;
    }
  }

  private stopWindowEntry(entry: ResourceWindowEntry): void {
    if (this.windows.get(entry.handle) !== entry) return;
    this.clearScheduledWork(entry);
    this.windows.delete(entry.handle);
    if (entry.live) this.deps.onUnsubscribe(entry.namespace, entry.uri);
  }

  private clearScheduledWork(entry: ResourceWindowEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.rateLimitTimer) clearTimeout(entry.rateLimitTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.debounceTimer = undefined;
    entry.rateLimitTimer = undefined;
    entry.retryTimer = undefined;
    entry.pendingUpdate = false;
  }

  private toPublicWindow(entry: ResourceWindowEntry): ResourceWindow {
    return {
      handle: entry.handle,
      generation: entry.generation,
      namespace: entry.namespace,
      uri: entry.uri,
      mimeType: entry.mimeType,
      live: entry.live,
      lastUpdateAt: entry.lastUpdateAt,
    };
  }
}
