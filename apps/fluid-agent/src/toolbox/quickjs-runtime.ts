import quickJsVariant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten-core';

import { createNamespaceController, type NamespaceBridge } from './namespace';
import type { CapabilitySnapshotMessage, ProviderRequest } from './protocol';
import {
  assertJsonValue,
  assertSerializedSize,
  type JsonValue,
} from './serialization';

export interface QuickJsExecutionOptions {
  source: string;
  snapshot: CapabilitySnapshotMessage;
  deadline: number;
  maximumOutputBytes: number;
  request(request: ProviderRequest): Promise<JsonValue>;
}

export interface PersistentQuickJsRuntime {
  execute(options: QuickJsExecutionOptions): Promise<JsonValue>;
  dispose(): void;
}

export interface QuickJsRuntimeOptions {
  memoryBytes: number;
  stackBytes: number;
}

export class FatalQuickJsError extends Error {}

export async function createQuickJsRuntime(
  options: QuickJsRuntimeOptions,
): Promise<PersistentQuickJsRuntime> {
  const module = await newQuickJSWASMModuleFromVariant(quickJsVariant);
  let deadline = Number.POSITIVE_INFINITY;
  const runtime = module.newRuntime({
    memoryLimitBytes: options.memoryBytes,
    maxStackSizeBytes: options.stackBytes,
    interruptHandler: () => Date.now() >= deadline,
  });
  const context = runtime.newContext();
  return new PersistentQuickJsRuntimeModule(
    context,
    runtime,
    createNamespaceController(context),
    (value) => {
      deadline = value;
    },
  );
}

class PersistentQuickJsRuntimeModule implements PersistentQuickJsRuntime {
  private active = false;
  private disposed = false;

  constructor(
    private readonly context: QuickJSContext,
    private readonly runtime: QuickJSRuntime,
    private readonly namespace: ReturnType<typeof createNamespaceController>,
    private readonly setDeadline: (deadline: number) => void,
  ) {}

  async execute(options: QuickJsExecutionOptions): Promise<JsonValue> {
    if (this.disposed)
      throw new FatalQuickJsError('QuickJS runtime is disposed');
    if (this.active) throw new FatalQuickJsError('QuickJS runtime is busy');
    this.active = true;
    this.setDeadline(options.deadline);
    const emissions: JsonValue[] = [];
    let wake: (() => void) | undefined;
    const bridge: NamespaceBridge = {
      request: (request) => {
        const promise = options.request(request);
        void promise.then(
          () => wake?.(),
          () => wake?.(),
        );
        return promise;
      },
      output: (value) => {
        appendEmission(emissions, value, options.maximumOutputBytes);
      },
    };

    try {
      this.namespace.activate(options.snapshot, bridge);
      const source = createExecutionSource(options.source);
      const evaluation = this.context.evalCode(source, 'toolbox-user-code.js', {
        strict: true,
      });
      let promiseHandle: QuickJSHandle;
      try {
        promiseHandle = this.context.unwrapResult(evaluation);
      } catch (error) {
        evaluation.dispose();
        throw error;
      }
      try {
        while (true) {
          executeJobs(this.runtime);
          const state = this.context.getPromiseState(promiseHandle);
          if (state.type === 'fulfilled') {
            try {
              const serializedReturn = this.context.dump(state.value);
              if (serializedReturn !== undefined) {
                if (typeof serializedReturn !== 'string')
                  throw new Error('Invalid serialized return value');
                appendEmission(
                  emissions,
                  JSON.parse(serializedReturn),
                  options.maximumOutputBytes,
                );
              }
            } finally {
              state.value.dispose();
            }
            break;
          }
          if (state.type === 'rejected') {
            const dumped = this.context.dump(state.error) as {
              message?: unknown;
            };
            state.error.dispose();
            throw new Error(
              typeof dumped?.message === 'string'
                ? dumped.message
                : 'Toolbox execution failed',
            );
          }
          if (Date.now() >= options.deadline)
            throw new FatalQuickJsError('Toolbox execution timed out');
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 5);
          });
          wake = undefined;
        }
      } finally {
        promiseHandle.dispose();
      }

      return normalizeEmissions(emissions);
    } catch (error) {
      if (error instanceof FatalQuickJsError) throw error;
      if (Date.now() >= options.deadline)
        throw new FatalQuickJsError('Toolbox execution timed out');
      throw error;
    } finally {
      this.namespace.deactivate();
      this.setDeadline(Number.POSITIVE_INFINITY);
      this.active = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context.dispose();
    this.runtime.dispose();
  }
}

function createExecutionSource(source: string): string {
  return `(async () => {
    const value = await (async () => { "use strict";\n${source}\n})();
    if (value === undefined) return undefined;
    const seen = new Set();
    const validate = (node, path) => {
      if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
      if (typeof node === 'number') {
        if (Number.isFinite(node)) return;
        throw new TypeError(path + ' must contain a finite number');
      }
      if (typeof node !== 'object')
        throw new TypeError(path + ' contains unsupported type ' + typeof node);
      if (seen.has(node)) throw new TypeError(path + ' contains a cycle');
      seen.add(node);
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index += 1)
          validate(node[index], path + '[' + index + ']');
      } else {
        const prototype = Object.getPrototypeOf(node);
        if (prototype !== Object.prototype && prototype !== null)
          throw new TypeError(path + ' must be a plain object');
        for (const key of Object.keys(node)) validate(node[key], path + '.' + key);
      }
      seen.delete(node);
    };
    validate(value, '$');
    return JSON.stringify(value);
  })()`;
}

function appendEmission(
  emissions: JsonValue[],
  value: unknown,
  maximumOutputBytes: number,
): void {
  assertJsonValue(value);
  const next = normalizeEmissions([...emissions, value]);
  assertSerializedSize(next, maximumOutputBytes, 'Output');
  emissions.push(value);
}

function normalizeEmissions(emissions: JsonValue[]): JsonValue {
  if (emissions.length === 0) return null;
  if (emissions.length === 1) return emissions[0] ?? null;
  return emissions;
}

function executeJobs(runtime: QuickJSRuntime): void {
  const result = runtime.executePendingJobs();
  try {
    if (result.error) result.error.context.unwrapResult(result);
  } finally {
    result.dispose();
  }
}
