import type { QuickJS, JSValueHandle } from 'quickjs-wasi';

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
import { toSerializedError, assertSerializedSize } from './serialization';

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

export interface NamespaceBridge {
  request(request: ProviderRequest): Promise<JsonValue>;
  emit(value: JsonValue): void;
  notify?(): void;
}

export interface NamespaceController {
  activate(snapshot: ToolSnapshotMessage, bridge: NamespaceBridge): void;
  deactivate(): void;
  dispose(): void;
}

export function createNamespaceController(
  context: QuickJS,
  maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BYTES,
): NamespaceController {
  let disposed = false;
  let activeBridge: NamespaceBridge | undefined;
  let activeSnapshot: ToolSnapshotMessage | undefined;
  const requireBridge = (): NamespaceBridge => {
    if (!activeBridge) throw new Error('No JavaScript execution is active');
    return activeBridge;
  };
  const isActive = (bridge: NamespaceBridge) =>
    !disposed && activeBridge === bridge;
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
      isActive,
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
      isActive,
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
      isActive,
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
      isActive,
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
      installMcpNamespace(context, snapshot, requireBridge, isActive);
    },
    dispose() {
      disposed = true;
      activeSnapshot = undefined;
      activeBridge = undefined;
    },
    deactivate() {
      activeSnapshot = undefined;
      activeBridge = undefined;
    },
  };
}

function installConsole(
  context: QuickJS,
  requireBridge: () => NamespaceBridge,
): void {
  const emit = context.newFunction('emitConsoleLog', (value) => {
    const dumped = context.dump(value);
    if (typeof dumped !== 'string')
      throw new TypeError('Console formatter must produce a string');
    requireBridge().emit(dumped);
    return context.undefined;
  });
  let factory: JSValueHandle | undefined;
  let consoleHandle: JSValueHandle | undefined;
  try {
    factory = context.evalCode(CONSOLE_FACTORY_SOURCE, 'console-format.js');
    consoleHandle = context.callFunction(factory, context.undefined, emit);
    context.setProp(context.global, 'console', consoleHandle);
  } finally {
    consoleHandle?.dispose();
    factory?.dispose();
    emit.dispose();
  }
}

function installMcpNamespace(
  context: QuickJS,
  snapshot: ToolSnapshotMessage,
  requireBridge: () => NamespaceBridge,
  isActive: (bridge: NamespaceBridge) => boolean,
): void {
  context.setProp(context.global, 'mcp', context.undefined);
  context.runGC();
  const mcp = context.newObject();
  try {
    for (const namespace of snapshot.namespaces) {
      const namespaceHandle = context.newObject();
      try {
        for (const capability of namespace.capabilities) {
          const callbackKey = `mcp:${JSON.stringify([namespace.name, capability.name])}`;
          context.unregisterHostCallback(callbackKey);
          const fn = createBridgeFunction(
            context,
            callbackKey,
            requireBridge,
            isActive,
            (input) => ({
              operation: 'invoke',
              reference: { namespace: namespace.name, name: capability.name },
              input: asInput(input),
            }),
          );
          const nameHandle = context.newString(capability.name);
          try {
            context.defineProp(fn, 'name', nameHandle, { configurable: true });
            context.setProp(namespaceHandle, capability.name, fn);
          } finally {
            nameHandle.dispose();
          }
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
  context: QuickJS,
  name: string,
  requireSnapshot: () => ToolSnapshotMessage,
  requireBridge: () => NamespaceBridge,
  isActive: (bridge: NamespaceBridge) => boolean,
  maximumResponseBytes: number,
  compute: (snapshot: ToolSnapshotMessage, ...args: unknown[]) => JsonValue,
): JSValueHandle {
  return context.newFunction(name, (...handles) => {
    const bridge = requireBridge();
    const snapshot = requireSnapshot();
    const args = handles.map((handle) => context.dump(handle));
    const value = compute(snapshot, ...args);
    assertSerializedSize(value, maximumResponseBytes, 'Provider response');
    return bridgePromise(context, bridge, isActive, Promise.resolve(value));
  });
}

function createBridgeFunction(
  context: QuickJS,
  name: string,
  requireBridge: () => NamespaceBridge,
  isActive: (bridge: NamespaceBridge) => boolean,
  request: (...args: unknown[]) => ProviderRequest,
): JSValueHandle {
  return context.newFunction(name, (...handles) => {
    const bridge = requireBridge();
    const args = handles.map((handle) => context.dump(handle));
    const pending = bridge.request(request(...args));
    return bridgePromise(context, bridge, isActive, pending);
  });
}

function bridgePromise(
  context: QuickJS,
  bridge: NamespaceBridge,
  isActive: (bridge: NamespaceBridge) => boolean,
  pending: Promise<JsonValue>,
): JSValueHandle {
  const deferred = context.newPromise();
  void pending
    .then((value) => {
      if (!isActive(bridge)) return;
      const handle = jsonToHandle(context, value);
      try {
        deferred.resolve(handle);
      } finally {
        handle.dispose();
      }
    })
    .catch((error: unknown) => {
      if (!isActive(bridge)) return;
      const serialized = toSerializedError(error);
      const handle = context.newError({
        name: serialized.name,
        message: serialized.message,
      });
      try {
        deferred.reject(handle);
      } finally {
        handle.dispose();
      }
    })
    .finally(() => {
      deferred.handle.dispose();
      if (isActive(bridge)) bridge.notify?.();
    });
  return deferred.handle;
}

function jsonToHandle(context: QuickJS, value: JsonValue): JSValueHandle {
  if (value === undefined) return context.undefined;
  assertJsonValue(value);
  return context.evalCode(
    `JSON.parse(${JSON.stringify(JSON.stringify(value))})`,
    'javascript-tool-value.js',
  );
}

function freeze(context: QuickJS, handle: JSValueHandle): void {
  const object = context.global.getProp('Object');
  const freezeFunction = object.getProp('freeze');
  try {
    context.callFunction(freezeFunction, object, handle).dispose();
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
