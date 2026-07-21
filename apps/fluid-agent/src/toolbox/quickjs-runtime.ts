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
    let output: JsonValue | undefined;
    let outputCalls = 0;
    let wake: (() => void) | undefined;
    const bridge: NamespaceBridge = {
      request: (request) => {
        const promise = options.request(request);
        void promise.finally(() => wake?.());
        return promise;
      },
      output: (value) => {
        outputCalls += 1;
        if (outputCalls !== 1) return;
        assertJsonValue(value);
        assertSerializedSize(value, options.maximumOutputBytes, 'Output');
        output = value;
      },
    };

    try {
      this.namespace.activate(options.snapshot, bridge);
      const source = `(async () => { "use strict";\n${options.source}\n})()`;
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
            state.value.dispose();
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

      if (outputCalls !== 1 || output === undefined)
        throw new Error('output() must be called exactly once');
      return output;
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

function executeJobs(runtime: QuickJSRuntime): void {
  const result = runtime.executePendingJobs();
  try {
    if (result.error) result.error.context.unwrapResult(result);
  } finally {
    result.dispose();
  }
}
