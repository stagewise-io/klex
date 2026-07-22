import { randomUUID } from 'node:crypto';
import { getAsset, isSea } from 'node:sea';
import { Worker } from 'node:worker_threads';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  type ProviderRequest,
  parseWorkerMessage,
  type WorkerMessage,
} from './protocol';
import {
  assertJsonValue,
  assertSerializedSize,
  type JsonObject,
  type JsonValue,
  toSerializedError,
} from './serialization';

export const TOOLBOX_LIMITS = Object.freeze({
  wallTimeMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  sourceBytes: 64 * 1024,
  maximumRequests: 50,
  maximumConcurrentRequests: 8,
  maximumProviderResponseBytes: 1024 * 1024,
  maximumOutputBytes: 256 * 1024,
  workerOldGenerationMb: 64,
  workerStackMb: 2,
});

export interface CapabilityReference {
  namespace: string;
  name: string;
}

export interface CapabilitySnapshot {
  namespaces: readonly {
    name: string;
    capabilities: readonly { name: string }[];
  }[];
}

export interface CapabilitySearchOptions {
  limit?: number;
}

export interface CapabilitySearchResult {
  reference: CapabilityReference;
  description?: string;
}

export interface CapabilityDescription {
  reference: CapabilityReference;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
}

export interface CapabilityRequestContext {
  executionId: string;
  signal: AbortSignal;
}

export interface CapabilityProvider {
  snapshot(context: CapabilityRequestContext): Promise<CapabilitySnapshot>;
  search(
    query: string,
    options: CapabilitySearchOptions,
    context: CapabilityRequestContext,
  ): Promise<CapabilitySearchResult[]>;
  describe(
    reference: CapabilityReference,
    context: CapabilityRequestContext,
  ): Promise<CapabilityDescription>;
  invoke(
    reference: CapabilityReference,
    input: JsonObject,
    context: CapabilityRequestContext,
  ): Promise<JsonValue>;
}

export interface ToolboxExecution {
  code: string;
  signal?: AbortSignal;
}

/**
 * A session-owned JavaScript toolbox with serialized executions and strict JSON
 * results. Explicit `globalThis` assignments persist until reset, fatal
 * recovery, or close. Executions normalize zero emissions to `null`, return one
 * emission directly, and aggregate multiple emissions in order.
 *
 * See `src/toolbox/README.md` for the guest API, lifecycle, and isolation model.
 */
export interface Toolbox {
  start(): Promise<void>;
  execute(input: ToolboxExecution): Promise<JsonValue>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface ToolboxDependencies {
  logging: RootLogger;
  provider: CapabilityProvider;
  workerUrl?: URL;
}

class ToolboxModule implements Toolbox {
  private worker: Worker | undefined;
  private activeAbort: AbortController | undefined;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      provider: CapabilityProvider;
      workerUrl?: URL;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error('Toolbox is closed');
    this.started = true;
    try {
      await this.ensureWorker();
      this.deps.logger.info('Toolbox started');
    } catch (error) {
      this.started = false;
      await this.invalidateWorker();
      throw error;
    }
  }

  execute(input: ToolboxExecution): Promise<JsonValue> {
    if (!this.started || this.closed)
      return Promise.reject(new Error('Toolbox is not started'));
    if (Buffer.byteLength(input.code, 'utf8') > TOOLBOX_LIMITS.sourceBytes) {
      return Promise.reject(
        new Error(`Source exceeds ${TOOLBOX_LIMITS.sourceBytes} bytes`),
      );
    }
    return this.enqueue(() => this.executeNow(input));
  }

  reset(): Promise<void> {
    if (!this.started || this.closed)
      return Promise.reject(new Error('Toolbox is not started'));
    return this.enqueue(async () => {
      await this.invalidateWorker();
      await this.ensureWorker();
      this.deps.logger.info('Toolbox reset');
    });
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.closed = true;
    this.started = false;
    this.activeAbort?.abort(new Error('Toolbox closed'));
    await this.queue.catch(() => undefined);
    await this.invalidateWorker();
    this.deps.logger.info('Toolbox stopped');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    const worker = new Worker(this.deps.workerUrl ?? resolveWorkerUrl(), {
      resourceLimits: {
        maxOldGenerationSizeMb: TOOLBOX_LIMITS.workerOldGenerationMb,
        stackSizeMb: TOOLBOX_LIMITS.workerStackMb,
      },
    });
    this.worker = worker;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        const fail = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const onError = (error: Error) => fail(error);
        const onExit = (code: number) =>
          fail(new Error(`Toolbox Worker exited with code ${code}`));
        const onMessage = (value: unknown) => {
          try {
            const message = parseWorkerMessage(value);
            if (message.type !== 'ready') return;
            cleanup();
            resolve();
          } catch (error) {
            fail(error);
          }
        };
        worker.on('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
        worker.postMessage({ type: 'initialize' });
      });
      return worker;
    } catch (error) {
      await this.invalidateWorker();
      throw error;
    }
  }

  private async invalidateWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }

  private async executeNow(input: ToolboxExecution): Promise<JsonValue> {
    if (this.closed) throw new Error('Toolbox is closed');
    if (input.signal?.aborted) throw input.signal.reason;
    const executionId = randomUUID();
    const abort = new AbortController();
    const onAbort = () => abort.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const context = { executionId, signal: abort.signal };
    this.activeAbort = abort;
    try {
      const snapshot = await this.deps.provider.snapshot(context);
      assertJsonValue(snapshot);
      if (abort.signal.aborted) throw abort.signal.reason;
      const worker = await this.ensureWorker();
      return await this.runExecution(
        worker,
        executionId,
        input.code,
        snapshot,
        abort,
      );
    } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
      input.signal?.removeEventListener('abort', onAbort);
      abort.abort(new Error('Execution finished'));
    }
  }

  private runExecution(
    worker: Worker,
    executionId: string,
    source: string,
    snapshot: CapabilitySnapshot,
    abort: AbortController,
  ): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let requests = 0;
      let concurrent = 0;
      const deadline = Date.now() + TOOLBOX_LIMITS.wallTimeMs;
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        abort.signal.removeEventListener('abort', onAbort);
      };
      const finish = (
        error?: unknown,
        result?: JsonValue,
        invalidate = false,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (invalidate) void this.invalidateWorker();
        error === undefined ? resolve(result ?? null) : reject(error);
      };
      const invalidate = (error: unknown) => finish(error, undefined, true);
      const timer = setTimeout(() => {
        abort.abort(new Error('Toolbox execution timed out'));
        invalidate(new Error('Toolbox execution timed out'));
      }, TOOLBOX_LIMITS.wallTimeMs);
      const onAbort = () => invalidate(abort.signal.reason);
      const onError = (error: Error) => invalidate(error);
      const onExit = (code: number) =>
        invalidate(new Error(`Toolbox Worker exited with code ${code}`));
      const onMessage = (value: unknown) => {
        let message: WorkerMessage;
        try {
          message = parseWorkerMessage(value);
        } catch (error) {
          invalidate(error);
          return;
        }
        if (message.type === 'ready' || message.executionId !== executionId)
          return;
        if (message.type === 'failure') {
          finish(
            Object.assign(new Error(message.error.message), {
              name: message.error.name,
            }),
            undefined,
            message.fatal,
          );
          return;
        }
        if (message.type === 'complete') {
          try {
            assertSerializedSize(
              message.result,
              TOOLBOX_LIMITS.maximumOutputBytes,
              'Output',
            );
            finish(undefined, message.result);
          } catch (error) {
            invalidate(error);
          }
          return;
        }
        requests += 1;
        concurrent += 1;
        if (
          requests > TOOLBOX_LIMITS.maximumRequests ||
          concurrent > TOOLBOX_LIMITS.maximumConcurrentRequests
        ) {
          invalidate(new Error('Provider request limit exceeded'));
          return;
        }
        void this.dispatch(message.request, contextFrom(executionId, abort))
          .then((result) => {
            if (settled) return;
            assertJsonValue(result);
            assertSerializedSize(
              result,
              TOOLBOX_LIMITS.maximumProviderResponseBytes,
              'Provider response',
            );
            worker.postMessage({
              type: 'provider-response',
              executionId,
              requestId: message.requestId,
              result,
            });
          })
          .catch((error: unknown) => {
            if (settled) return;
            worker.postMessage({
              type: 'provider-error',
              executionId,
              requestId: message.requestId,
              error: toSerializedError(error, 'PROVIDER_ERROR'),
            });
          })
          .finally(() => {
            concurrent -= 1;
          });
      };

      abort.signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
      worker.postMessage({
        type: 'execute',
        executionId,
        source,
        snapshot,
        deadline,
      });
    });
  }

  private async dispatch(
    request: ProviderRequest,
    context: CapabilityRequestContext,
  ): Promise<JsonValue> {
    let result: unknown;
    switch (request.operation) {
      case 'search':
        result = await this.deps.provider.search(
          request.query,
          { limit: request.limit },
          context,
        );
        break;
      case 'describe':
        result = await this.deps.provider.describe(request.reference, context);
        break;
      case 'invoke':
        result = await this.deps.provider.invoke(
          request.reference,
          request.input,
          context,
        );
        break;
    }
    assertJsonValue(result);
    return result;
  }
}

function contextFrom(
  executionId: string,
  abort: AbortController,
): CapabilityRequestContext {
  return { executionId, signal: abort.signal };
}

function resolveWorkerUrl(): URL {
  if (isSea()) {
    const source = getAsset('toolbox-worker.js', 'utf8');
    return new URL(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
    );
  }
  return new URL('./toolbox-worker.js', import.meta.url);
}

export function createToolbox(deps: ToolboxDependencies): Toolbox {
  return new ToolboxModule({
    logger: deps.logging.child({
      name: 'toolbox',
      bindings: { module: 'toolbox' },
    }),
    provider: deps.provider,
    workerUrl: deps.workerUrl,
  });
}
