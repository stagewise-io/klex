import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';

import {
  assertJsonValue,
  type JsonValue,
  parseToolListNamespacesOptions,
  parseToolListToolsOptions,
  parseToolSearchOptions,
  TOOL_LIST_NAMESPACES_USAGE,
  TOOL_LIST_TOOLS_USAGE,
  TOOL_SEARCH_USAGE,
} from '@/tool-provider';

import { CONSOLE_FACTORY_SOURCE } from './console-format';
import type { ProviderRequest, ToolSnapshotMessage } from './protocol';
import { assertSerializedSize } from './serialization';

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

export interface NamespaceBridge {
  request(request: ProviderRequest): Promise<JsonValue>;
  emit(value: JsonValue): void;
  notify?(): void;
}

export interface NamespaceController {
  activate(snapshot: ToolSnapshotMessage, bridge: NamespaceBridge): void;
  deactivate(): void;
}

export function createNamespaceController(
  context: QuickJSContext,
  maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BYTES,
): NamespaceController {
  let activeBridge: NamespaceBridge | undefined;
  let activeSnapshot: ToolSnapshotMessage | undefined;
  const requireBridge = (): NamespaceBridge => {
    if (!activeBridge) throw new Error('No JavaScript execution is active');
    return activeBridge;
  };
  const requireSnapshot = (): ToolSnapshotMessage => {
    if (!activeSnapshot) throw new Error('No JavaScript execution is active');
    return activeSnapshot;
  };

  const tools = context.newObject();
  try {
    const listNamespaces = createSnapshotFunction(
      context,
      'listNamespaces',
      requireSnapshot,
      requireBridge,
      maximumResponseBytes,
      (snapshot, ...args) => {
        if (args.length > 1) {
          throw new TypeError(
            `tools.listNamespaces accepts at most 1 argument. ${TOOL_LIST_NAMESPACES_USAGE}`,
          );
        }
        const { limit } = parseToolListNamespacesOptions(args[0]);
        const namespaces = snapshot.namespaces.map((namespace) => ({
          namespace: namespace.name,
          tools: namespace.capabilities.map((capability) => capability.name),
        }));
        return limit === undefined ? namespaces : namespaces.slice(0, limit);
      },
    );
    const listTools = createSnapshotFunction(
      context,
      'listTools',
      requireSnapshot,
      requireBridge,
      maximumResponseBytes,
      (snapshot, ...args) => {
        if (args.length > 1) {
          throw new TypeError(
            `tools.listTools accepts at most 1 argument. ${TOOL_LIST_TOOLS_USAGE}`,
          );
        }
        const { namespace, limit } = parseToolListToolsOptions(args[0]);
        const matchingNamespaces =
          namespace === undefined
            ? snapshot.namespaces
            : snapshot.namespaces.filter((entry) => entry.name === namespace);
        const listed = matchingNamespaces.flatMap((entry) =>
          entry.capabilities.map((capability) => ({
            reference: {
              namespace: entry.name,
              name: capability.name,
            },
          })),
        );
        return limit === undefined ? listed : listed.slice(0, limit);
      },
    );
    const search = createBridgeFunction(
      context,
      'search',
      requireBridge,
      (query, options) => {
        if (typeof query !== 'string')
          throw new TypeError(
            `Search query must be a string. ${TOOL_SEARCH_USAGE}`,
          );
        const parsedOptions = parseToolSearchOptions(options);
        return {
          operation: 'search',
          query,
          ...parsedOptions,
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
    context.setProp(tools, 'listNamespaces', listNamespaces);
    context.setProp(tools, 'listTools', listTools);
    context.setProp(tools, 'search', search);
    context.setProp(tools, 'describe', describe);
    listNamespaces.dispose();
    listTools.dispose();
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
      activeSnapshot = snapshot;
      activeBridge = bridge;
      installMcpNamespace(context, snapshot, requireBridge);
    },
    deactivate() {
      activeSnapshot = undefined;
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

function createSnapshotFunction(
  context: QuickJSContext,
  name: string,
  requireSnapshot: () => ToolSnapshotMessage,
  requireBridge: () => NamespaceBridge,
  maximumResponseBytes: number,
  compute: (snapshot: ToolSnapshotMessage, ...args: unknown[]) => JsonValue,
): QuickJSHandle {
  return context.newFunction(name, (...handles) => {
    const deferred = context.newPromise();
    try {
      const bridge = requireBridge();
      const snapshot = requireSnapshot();
      const args = handles.map((handle) => context.dump(handle));
      const value = compute(snapshot, ...args);
      assertSerializedSize(value, maximumResponseBytes, 'Provider response');
      void Promise.resolve(value).then((resolved) => {
        const handle = jsonToHandle(context, resolved);
        try {
          deferred.resolve(handle);
        } finally {
          handle.dispose();
          deferred.dispose();
          bridge.notify?.();
        }
      });
      return deferred.handle;
    } catch (error) {
      deferred.dispose();
      throw error;
    }
  });
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
  const usage =
    'Tool input must be a plain JSON object. Use mcp[namespace][name](input), e.g. mcp[namespace][name]({ value: 1 }) when its input schema requires a value. Inspect tools.search(query, { includeInputSchema: true }) or tools.describe({ namespace, name }) for the required fields.';
  try {
    assertJsonValue(value);
  } catch {
    throw new TypeError(usage);
  }
  if (!isRecord(value)) throw new TypeError(usage);
  return value;
}

function asReference(value: unknown): { namespace: string; name: string } {
  if (
    !isRecord(value) ||
    typeof value.namespace !== 'string' ||
    value.namespace.trim().length === 0 ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0
  ) {
    throw new TypeError(
      'Tool reference must contain non-empty namespace and name strings. Use tools.describe({ namespace: string, name: string }), e.g. tools.describe(matches[0].reference) after tools.search("deployment") or tools.listTools(). Use the exact returned names.',
    );
  }
  return { namespace: value.namespace, name: value.name };
}

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
