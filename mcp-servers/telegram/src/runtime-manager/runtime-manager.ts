import { createHmac, randomBytes } from 'node:crypto';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { createEventStore, type EventStore } from '../event-store.js';
import {
  createTelegramMcp,
  type TelegramMcp,
  type TelegramMcpOptions,
} from '../mcp.js';
import {
  createTelegramChannel,
  type TelegramChannel,
  type TelegramChannelDependencies,
} from '../telegram.js';
import {
  parseTelegramCredentials,
  TelegramCredentialError,
  type TelegramCredentials,
} from './credentials.js';

interface TelegramRuntime {
  readonly key: string;
  readonly channel: TelegramChannel;
  readonly eventStore: EventStore;
  readonly mcp: TelegramMcp;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasActiveSubscription: boolean;
  closing: boolean;
}

export interface TelegramRuntimeManagerDependencies {
  logging: RootLogger;
  processSecret?: Uint8Array;
  idleTimeoutMs?: number;
  createEventStore?: () => EventStore;
  createChannel?: (deps: TelegramChannelDependencies) => TelegramChannel;
  createMcp?: (
    channel: TelegramChannel,
    eventStore: EventStore,
    options: TelegramMcpOptions,
  ) => TelegramMcp;
}

export interface TelegramRuntimeManager {
  fetch(request: Request): Promise<Response>;
  health(): {
    activeRuntimeCount: number;
    startingRuntimeCount: number;
  };
  close(): Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

class TelegramRuntimeManagerModule implements TelegramRuntimeManager {
  readonly #logging: RootLogger;
  readonly #logger: ModuleLogger;
  readonly #processSecret: Uint8Array;
  readonly #idleTimeoutMs: number;
  readonly #createEventStore: () => EventStore;
  readonly #createChannel: (
    deps: TelegramChannelDependencies,
  ) => TelegramChannel;
  readonly #createMcp: (
    channel: TelegramChannel,
    eventStore: EventStore,
    options: TelegramMcpOptions,
  ) => TelegramMcp;
  readonly #runtimes = new Map<string, TelegramRuntime>();
  readonly #creations = new Map<string, Promise<TelegramRuntime>>();
  #closed = false;

  constructor(deps: TelegramRuntimeManagerDependencies) {
    this.#logging = deps.logging;
    this.#logger = deps.logging.child({
      name: 'telegram-runtime-manager',
      bindings: { module: 'telegram-runtime-manager' },
    });
    this.#processSecret = deps.processSecret ?? randomBytes(32);
    this.#idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#createEventStore = deps.createEventStore ?? createEventStore;
    this.#createChannel = deps.createChannel ?? createTelegramChannel;
    this.#createMcp = deps.createMcp ?? createTelegramMcp;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#closed)
      return this.#error(503, 'Telegram proxy is shutting down');
    let credentials: TelegramCredentials;
    try {
      credentials = parseTelegramCredentials(request);
    } catch (error) {
      if (error instanceof TelegramCredentialError) {
        return this.#error(error.status, error.message);
      }
      return this.#error(400, 'Invalid Telegram credentials');
    }

    const key = this.#deriveRuntimeKey(credentials.botToken);
    let runtime: TelegramRuntime;
    try {
      runtime = await this.#getOrCreate(key, credentials);
    } catch {
      this.#logger.warn({}, 'Failed to create Telegram runtime');
      return this.#error(401, 'Telegram authentication failed');
    }
    runtime.channel.updateAllowedUserIds(credentials.allowedUserIds);
    this.#scheduleIdleShutdown(runtime);
    try {
      return await runtime.mcp.fetch(request);
    } catch {
      this.#logger.warn({}, 'Telegram MCP request failed');
      return this.#error(500, 'Telegram MCP request failed');
    }
  }

  health(): {
    activeRuntimeCount: number;
    startingRuntimeCount: number;
  } {
    return {
      activeRuntimeCount: this.#runtimes.size,
      startingRuntimeCount: this.#creations.size,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(this.#creations.values());
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    await Promise.all(runtimes.map((runtime) => this.#closeRuntime(runtime)));
  }

  #deriveRuntimeKey(botToken: string): string {
    return createHmac('sha256', this.#processSecret)
      .update(botToken)
      .digest('hex');
  }

  async #getOrCreate(
    key: string,
    credentials: TelegramCredentials,
  ): Promise<TelegramRuntime> {
    const existing = this.#runtimes.get(key);
    if (existing) return existing;
    const inFlight = this.#creations.get(key);
    if (inFlight) return inFlight;

    const creation = this.#createRuntime(key, credentials);
    this.#creations.set(key, creation);
    try {
      const runtime = await creation;
      if (this.#closed) {
        await this.#closeRuntime(runtime);
        throw new Error('Runtime manager closed during startup');
      }
      this.#runtimes.set(key, runtime);
      this.#scheduleIdleShutdown(runtime);
      return runtime;
    } finally {
      this.#creations.delete(key);
    }
  }

  async #createRuntime(
    key: string,
    credentials: TelegramCredentials,
  ): Promise<TelegramRuntime> {
    const eventStore = this.#createEventStore();
    let mcp: TelegramMcp | undefined;
    const channel = this.#createChannel({
      token: credentials.botToken,
      allowedUserIds: credentials.allowedUserIds,
      logging: this.#logging,
      onMessage: (message) => {
        const result = eventStore.append(message);
        if (result.isNew) mcp?.publish(result.notification);
      },
    });
    let runtime: TelegramRuntime | undefined;
    mcp = this.#createMcp(channel, eventStore, {
      onSubscriptionStateChanged: (active) => {
        if (!runtime || runtime.closing) return;
        runtime.hasActiveSubscription = active;
        if (active) this.#clearIdleTimer(runtime);
        else this.#scheduleIdleShutdown(runtime);
      },
    });
    runtime = {
      key,
      channel,
      eventStore,
      mcp,
      hasActiveSubscription: false,
      closing: false,
    };
    try {
      await channel.start();
      return runtime;
    } catch (error) {
      await mcp.close().catch(() => undefined);
      await channel.close().catch(() => undefined);
      await eventStore.close();
      throw error;
    }
  }

  #scheduleIdleShutdown(runtime: TelegramRuntime): void {
    if (runtime.closing || runtime.hasActiveSubscription) return;
    this.#clearIdleTimer(runtime);
    runtime.idleTimer = setTimeout(() => {
      if (runtime.closing || runtime.hasActiveSubscription) return;
      if (this.#runtimes.get(runtime.key) !== runtime) return;
      this.#runtimes.delete(runtime.key);
      void this.#closeRuntime(runtime);
    }, this.#idleTimeoutMs);
  }

  #clearIdleTimer(runtime: TelegramRuntime): void {
    if (!runtime.idleTimer) return;
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }

  async #closeRuntime(runtime: TelegramRuntime): Promise<void> {
    if (runtime.closing) return;
    runtime.closing = true;
    this.#clearIdleTimer(runtime);
    await runtime.mcp.close().catch(() => undefined);
    await runtime.channel.close().catch(() => undefined);
    await runtime.eventStore.close();
  }

  #error(status: number, message: string): Response {
    return Response.json({ error: message }, { status });
  }
}

export function createTelegramRuntimeManager(
  deps: TelegramRuntimeManagerDependencies,
): TelegramRuntimeManager {
  return new TelegramRuntimeManagerModule(deps);
}
