import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { ToolSet } from 'ai';
import z from 'zod';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  assertJsonValue,
  type JsonValue,
  type ToolProvider,
  type ToolRequestContext,
  type ToolSnapshot,
} from '@/tool-provider';

import {
  type ProviderRequest,
  parseWorkerMessage,
  type WorkerMessage,
} from './protocol';
import { assertSerializedSize, toSerializedError } from './serialization';

export const JAVASCRIPT_SANDBOX_LIMITS = Object.freeze({
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

export interface JavaScriptExecution {
  code: string;
  signal?: AbortSignal;
}

/**
 * A session-owned JavaScript tool with serialized executions and strict JSON
 * results. Explicit `globalThis` assignments persist until reset, fatal
 * recovery, or close. Executions normalize zero emissions to `null`, return one
 * emission directly, and aggregate multiple emissions in order.
 *
 * See this module's `README.md` for the guest API, lifecycle, and isolation model.
 */
export interface JavaScriptTool {
  start(): Promise<void>;
  execute(input: JavaScriptExecution): Promise<JsonValue>;
  reset(): Promise<void>;
  readonly tools: ToolSet;
  close(): Promise<void>;
  /** Sets the session ID for associating tool calls with sessions. */
  sessionId: string | undefined;
}

export interface JavaScriptToolDependencies {
  logging: RootLogger;
  provider: ToolProvider;
  workerUrl?: URL;
}

class JavaScriptToolModule implements JavaScriptTool {
  private worker: Worker | undefined;
  private workerTempDir: string | undefined;
  private activeAbort: AbortController | undefined;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  sessionId: string | undefined;

  readonly tools = {
    runJavascript: {
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            'JavaScript code executed in an async QuickJS wrapper. Top-level await is supported. Return one JSON result or emit one or more JSON values with output().',
          ),
      }),
      outputSchema: z
        .json()
        .describe(
          'The JSON result emitted or returned by the executed code. Multiple emissions are returned as an array.',
        ),
      execute: async ({ code }, options) =>
        this.execute({ code, signal: options.abortSignal }),
    },
  } satisfies ToolSet;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      provider: ToolProvider;
      workerUrl?: URL;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error('JavaScript tool is closed');
    this.started = true;
    try {
      await this.ensureWorker();
      this.deps.logger.info('JavaScript tool started');
    } catch (error) {
      this.started = false;
      await this.invalidateWorker();
      throw error;
    }
  }

  execute(input: JavaScriptExecution): Promise<JsonValue> {
    if (!this.started || this.closed)
      return Promise.reject(new Error('JavaScript tool is not started'));
    if (
      Buffer.byteLength(input.code, 'utf8') >
      JAVASCRIPT_SANDBOX_LIMITS.sourceBytes
    ) {
      return Promise.reject(
        new Error(
          `Source exceeds ${JAVASCRIPT_SANDBOX_LIMITS.sourceBytes} bytes`,
        ),
      );
    }
    return this.enqueue(() => this.executeNow(input));
  }

  reset(): Promise<void> {
    if (!this.started || this.closed)
      return Promise.reject(new Error('JavaScript tool is not started'));
    return this.enqueue(async () => {
      await this.invalidateWorker();
      await this.ensureWorker();
      this.deps.logger.info('JavaScript tool reset');
    });
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.closed = true;
    this.started = false;
    this.activeAbort?.abort(new Error('JavaScript tool closed'));
    await this.queue.catch(() => undefined);
    await this.invalidateWorker();
    this.deps.logger.info('JavaScript tool stopped');
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
    const { url, tempDir } = this.deps.workerUrl
      ? { url: this.deps.workerUrl, tempDir: undefined }
      : resolveWorkerUrl();
    this.workerTempDir = tempDir;
    const worker = new Worker(url, {
      resourceLimits: {
        maxOldGenerationSizeMb: JAVASCRIPT_SANDBOX_LIMITS.workerOldGenerationMb,
        stackSizeMb: JAVASCRIPT_SANDBOX_LIMITS.workerStackMb,
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
          fail(new Error(`JavaScript sandbox Worker exited with code ${code}`));
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
    // Capture and clear temp-dir ownership synchronously before awaiting
    // terminate(). A fatal execution fires invalidateWorker() without
    // awaiting it (see finish() in runExecution). The queue then advances to
    // the next execution, which calls ensureWorker() and assigns a new
    // temp dir to this.workerTempDir. If we read this.workerTempDir after
    // the await, we would delete the replacement worker's directory.
    const tempDir = this.workerTempDir;
    this.workerTempDir = undefined;
    if (worker) await worker.terminate();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }

  private async executeNow(input: JavaScriptExecution): Promise<JsonValue> {
    if (this.closed) throw new Error('JavaScript tool is closed');
    if (input.signal?.aborted) throw input.signal.reason;
    const executionId = randomUUID();
    const abort = new AbortController();
    const onAbort = () => abort.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const context = {
      executionId,
      signal: abort.signal,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
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
    snapshot: ToolSnapshot,
    abort: AbortController,
  ): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let requests = 0;
      let concurrent = 0;
      const deadline = Date.now() + JAVASCRIPT_SANDBOX_LIMITS.wallTimeMs;
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
        abort.abort(new Error('JavaScript execution timed out'));
        invalidate(new Error('JavaScript execution timed out'));
      }, JAVASCRIPT_SANDBOX_LIMITS.wallTimeMs);
      const onAbort = () => invalidate(abort.signal.reason);
      const onError = (error: Error) => invalidate(error);
      const onExit = (code: number) =>
        invalidate(
          new Error(`JavaScript sandbox Worker exited with code ${code}`),
        );
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
              JAVASCRIPT_SANDBOX_LIMITS.maximumOutputBytes,
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
          requests > JAVASCRIPT_SANDBOX_LIMITS.maximumRequests ||
          concurrent > JAVASCRIPT_SANDBOX_LIMITS.maximumConcurrentRequests
        ) {
          invalidate(new Error('Provider request limit exceeded'));
          return;
        }
        void this.dispatch(
          message.request,
          contextFrom(executionId, abort, this.sessionId),
        )
          .then((result) => {
            if (settled) return;
            assertJsonValue(result);
            assertSerializedSize(
              result,
              JAVASCRIPT_SANDBOX_LIMITS.maximumProviderResponseBytes,
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
    context: ToolRequestContext,
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
  sessionId?: string,
): ToolRequestContext {
  return {
    executionId,
    signal: abort.signal,
    ...(sessionId ? { sessionId } : {}),
  };
}

function resolveWorkerUrl(): { url: URL; tempDir?: string } {
  if (isSea()) {
    const source = getAsset('javascript-sandbox-worker.js', 'utf8');
    // Node's Worker constructor rejects data: URLs (ERR_WORKER_PATH).
    // Write the embedded worker to a temp .mjs file so it can be loaded as ESM.
    const dir = mkdtempSync(join(tmpdir(), 'fluid-agent-worker-'));
    const workerPath = join(dir, 'javascript-sandbox-worker.mjs');
    writeFileSync(workerPath, source, 'utf8');
    return { url: pathToFileURL(workerPath), tempDir: dir };
  }
  return { url: new URL('./javascript-sandbox-worker.js', import.meta.url) };
}

export function createJavaScriptTool(
  deps: JavaScriptToolDependencies,
): JavaScriptTool {
  return new JavaScriptToolModule({
    logger: deps.logging.child({
      name: 'javascript-tool',
      bindings: { module: 'javascript-tool' },
    }),
    provider: deps.provider,
    workerUrl: deps.workerUrl,
  });
}
