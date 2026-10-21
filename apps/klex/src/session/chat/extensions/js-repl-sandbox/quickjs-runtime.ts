import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  QuickJS,
  JSException,
  MAX_STACK_SIZE,
  type QuickJSOptions,
  type JSValueHandle,
} from 'quickjs-wasi';

import { assertJsonValue, type JsonValue } from '@/tool-provider';

import { createNamespaceController, type NamespaceBridge } from './namespace';
import type { ProviderRequest, ToolSnapshotMessage } from './protocol';
import { assertSerializedSize } from './serialization';

export interface QuickJsExecutionOptions {
  source: string;
  snapshot: ToolSnapshotMessage;
  deadline: number;
  maximumOutputBytes: number;
  isAborted?(): boolean;
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

// This Node-only project excludes DOM types; declare just the WASM compiler.
declare const WebAssembly: {
  compile(bytes: Uint8Array): Promise<QuickJSOptions['wasm']>;
};
let compiledModules:
  | Promise<{ wasm: QuickJSOptions['wasm']; encoding: QuickJSOptions['wasm'] }>
  | undefined;
function loadModules() {
  return (compiledModules ??= (async () => {
    let wasm: Uint8Array;
    let encoding: Uint8Array;
    try {
      // Literal requires let esbuild embed both binaries. Never use ESM WASM
      // imports: Node's native loader tries to resolve the guest 'env' import.
      wasm = require('quickjs-wasi/quickjs.wasm');
      encoding = require('quickjs-wasi/encoding.so');
    } catch {
      const require = createRequire(import.meta.url);
      [wasm, encoding] = await Promise.all([
        readFile(require.resolve('quickjs-wasi/quickjs.wasm')),
        readFile(require.resolve('quickjs-wasi/encoding.so')),
      ]);
    }
    return {
      wasm: await WebAssembly.compile(wasm),
      encoding: await WebAssembly.compile(encoding),
    };
  })());
}

export async function createQuickJsRuntime(
  options: QuickJsRuntimeOptions,
): Promise<PersistentQuickJsRuntime> {
  const { wasm, encoding } = await loadModules();
  let interrupt: (() => boolean) | null = null;
  const vm = await QuickJS.create({
    memoryLimit: options.memoryBytes,
    maxStackSize: Math.min(options.stackBytes, MAX_STACK_SIZE),
    wasm,
    extensions: [{ name: 'encoding', wasm: encoding }],
    interruptHandler: () => interrupt?.() ?? false,
  });
  return new PersistentQuickJsRuntimeModule(
    vm,
    createNamespaceController(vm),
    (handler) => {
      interrupt = handler;
    },
  );
}

class PersistentQuickJsRuntimeModule implements PersistentQuickJsRuntime {
  private active = false;
  private disposed = false;

  constructor(
    private readonly context: QuickJS,
    private readonly namespace: ReturnType<typeof createNamespaceController>,
    private readonly setInterruptHandler: (
      handler: (() => boolean) | null,
    ) => void,
  ) {}

  async execute(options: QuickJsExecutionOptions): Promise<JsonValue> {
    if (this.disposed)
      throw new FatalQuickJsError('QuickJS runtime is disposed');
    if (this.active) throw new FatalQuickJsError('QuickJS runtime is busy');
    this.active = true;
    this.setInterruptHandler(
      () => options.isAborted?.() === true || Date.now() >= options.deadline,
    );
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
      emit: (value) => {
        appendEmission(emissions, value, options.maximumOutputBytes);
      },
      notify: () => {
        wake?.();
      },
    };

    try {
      this.namespace.activate(options.snapshot, bridge);
      const source = createExecutionSource(options.source);
      const promiseHandle = this.context.evalCode(source, 'sandbox.js');
      try {
        while (true) {
          if (this.disposed)
            throw new FatalQuickJsError('QuickJS runtime is disposed');
          executeJobs(this.context);
          const status = promiseHandle.promiseState;
          if (status !== 0) {
            const state = await this.context.resolvePromise(promiseHandle);
            if ('error' in state) {
              try {
                throw extractError(this.context, state.error);
              } finally {
                state.error.dispose();
              }
            }
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
          if (Date.now() >= options.deadline)
            throw new FatalQuickJsError('JavaScript execution timed out');
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
      if (error instanceof JSException) {
        const exception = error;
        try {
          error = extractError(this.context, exception.handle);
        } finally {
          exception.dispose();
        }
      }
      if (error instanceof FatalQuickJsError) throw error;
      if (
        (error instanceof Error &&
          error.name === 'InternalError' &&
          error.message === 'interrupted') ||
        Date.now() >= options.deadline
      )
        throw new FatalQuickJsError('JavaScript execution timed out');
      throw error;
    } finally {
      this.namespace.deactivate();
      if (!this.disposed) this.setInterruptHandler(null);
      this.active = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.namespace.dispose();
    this.context.dispose();
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

function executeJobs(vm: QuickJS): void {
  // executePendingJobs currently drops negative return values from the C API.
  const exports = (
    vm as unknown as {
      _getExports(): {
        qjs_is_job_pending(): number;
        qjs_execute_pending_job(): number;
      };
    }
  )._getExports();
  while (exports.qjs_is_job_pending()) {
    if (exports.qjs_execute_pending_job() < 0) {
      const handle = vm.getException();
      try {
        throw extractError(vm, handle);
      } finally {
        handle.dispose();
      }
    }
  }
}

function extractError(vm: QuickJS, handle: JSValueHandle): Error {
  if (vm.typeof(handle) === 'object' && !handle.isNull) {
    const name = handle.getProp('name');
    const message = handle.getProp('message');
    try {
      return Object.assign(
        new Error(
          vm.typeof(message) === 'string'
            ? message.toString()
            : 'JavaScript execution failed',
        ),
        {
          name: vm.typeof(name) === 'string' ? name.toString() : 'Error',
        },
      );
    } finally {
      name.dispose();
      message.dispose();
    }
  }
  return Object.assign(new Error(handle.toString()), { name: 'Error' });
}
