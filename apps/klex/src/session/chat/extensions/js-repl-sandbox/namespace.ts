import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';

import { assertJsonValue, type JsonValue } from '@/tool-provider';

import { CONSOLE_FACTORY_SOURCE } from './console-format';
import type { ProviderRequest, ToolSnapshotMessage } from './protocol';

export interface NamespaceBridge {
  request(request: ProviderRequest): Promise<JsonValue>;
  emit(value: JsonValue): void;
}

export interface NamespaceController {
  activate(snapshot: ToolSnapshotMessage, bridge: NamespaceBridge): void;
  deactivate(): void;
}

export function createNamespaceController(
  context: QuickJSContext,
): NamespaceController {
  let activeBridge: NamespaceBridge | undefined;
  const requireBridge = (): NamespaceBridge => {
    if (!activeBridge) throw new Error('No JavaScript execution is active');
    return activeBridge;
  };

  const tools = context.newObject();
  try {
    const search = createBridgeFunction(
      context,
      'search',
      requireBridge,
      (query, options) => {
        if (typeof query !== 'string')
          throw new TypeError('tools.search query must be a string');
        const limit =
          isRecord(options) && typeof options.limit === 'number'
            ? options.limit
            : undefined;
        return {
          operation: 'search',
          query,
          ...(limit === undefined ? {} : { limit }),
        };
      },
    );
    const describe = createBridgeFunction(
      context,
      'describe',
      requireBridge,
      (reference) => ({
        operation: 'describe',
        reference: asReference(reference),
      }),
    );
    context.setProp(tools, 'search', search);
    context.setProp(tools, 'describe', describe);
    search.dispose();
    describe.dispose();
    freeze(context, tools);
    context.setProp(context.global, 'tools', tools);
  } finally {
    tools.dispose();
  }

  installConsole(context, requireBridge);

  return {
    activate(snapshot, bridge) {
      activeBridge = bridge;
      installMcpNamespace(context, snapshot, requireBridge);
    },
    deactivate() {
      activeBridge = undefined;
    },
  };
}

function installConsole(
  context: QuickJSContext,
  requireBridge: () => NamespaceBridge,
): void {
  const emit = context.newFunction('emitConsoleLog', (value) => {
    const dumped = context.dump(value);
    if (typeof dumped !== 'string')
      throw new TypeError('Console formatter must produce a string');
    requireBridge().emit(dumped);
  });
  let factory: QuickJSHandle | undefined;
  let consoleHandle: QuickJSHandle | undefined;
  try {
    factory = context.unwrapResult(
      context.evalCode(CONSOLE_FACTORY_SOURCE, 'console-format.js', {
        strict: true,
      }),
    );
    consoleHandle = context.unwrapResult(
      context.callFunction(factory, context.undefined, emit),
    );
    context.setProp(context.global, 'console', consoleHandle);
  } finally {
    consoleHandle?.dispose();
    factory?.dispose();
    emit.dispose();
  }
}

function installMcpNamespace(
  context: QuickJSContext,
  snapshot: ToolSnapshotMessage,
  requireBridge: () => NamespaceBridge,
): void {
  const mcp = context.newObject();
  try {
    for (const namespace of snapshot.namespaces) {
      const namespaceHandle = context.newObject();
      try {
        for (const capability of namespace.capabilities) {
          const fn = createBridgeFunction(
            context,
            capability.name,
            requireBridge,
            (input) => ({
              operation: 'invoke',
              reference: { namespace: namespace.name, name: capability.name },
              input: asInput(input),
            }),
          );
          context.setProp(namespaceHandle, capability.name, fn);
          fn.dispose();
        }
        freeze(context, namespaceHandle);
        context.setProp(mcp, namespace.name, namespaceHandle);
      } finally {
        namespaceHandle.dispose();
      }
    }
    freeze(context, mcp);
    context.setProp(context.global, 'mcp', mcp);
  } finally {
    mcp.dispose();
  }
}

function createBridgeFunction(
  context: QuickJSContext,
  name: string,
  requireBridge: () => NamespaceBridge,
  request: (...args: unknown[]) => ProviderRequest,
): QuickJSHandle {
  return context.newFunction(name, (...handles) => {
    const deferred = context.newPromise();
    try {
      const args = handles.map((handle) => context.dump(handle));
      const pending = requireBridge().request(request(...args));
      void pending.then(
        (value) => {
          const handle = jsonToHandle(context, value);
          try {
            deferred.resolve(handle);
          } finally {
            handle.dispose();
            deferred.dispose();
          }
        },
        (error: unknown) => {
          const handle = context.newError(
            error instanceof Error ? error.message : 'Provider request failed',
          );
          try {
            deferred.reject(handle);
          } finally {
            handle.dispose();
            deferred.dispose();
          }
        },
      );
      return deferred.handle;
    } catch (error) {
      deferred.dispose();
      throw error;
    }
  });
}

function jsonToHandle(
  context: QuickJSContext,
  value: JsonValue,
): QuickJSHandle {
  assertJsonValue(value);
  const source = `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
  return context.unwrapResult(
    context.evalCode(source, 'javascript-tool-value.js', { strict: true }),
  );
}

function freeze(context: QuickJSContext, handle: QuickJSHandle): void {
  const object = context.getProp(context.global, 'Object');
  const freezeFunction = context.getProp(object, 'freeze');
  try {
    context
      .unwrapResult(context.callFunction(freezeFunction, object, handle))
      .dispose();
  } finally {
    freezeFunction.dispose();
    object.dispose();
  }
}

function asInput(value: unknown): { [key: string]: JsonValue } {
  assertJsonValue(value);
  if (!isRecord(value))
    throw new TypeError('Tool input must be a plain object');
  return value;
}

function asReference(value: unknown): { namespace: string; name: string } {
  if (
    !isRecord(value) ||
    typeof value.namespace !== 'string' ||
    typeof value.name !== 'string'
  ) {
    throw new TypeError('Tool reference must contain namespace and name');
  }
  return { namespace: value.namespace, name: value.name };
}

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
