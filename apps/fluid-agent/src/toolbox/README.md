# QuickJS Toolbox

The toolbox is the Fluid Agent's isolated JavaScript orchestration environment. It exposes capabilities through a narrow JSON-only provider seam without adding every external tool to the model's native AI SDK tool list.

## Ownership and lifecycle

One `Toolbox` owns one Node Worker, QuickJS runtime, and QuickJS context while started.

- `start()` creates the Worker and waits for QuickJS readiness.
- `execute()` queues work in FIFO order; one context never evaluates two executions concurrently.
- `reset()` replaces the Worker/runtime/context and clears guest state while keeping the toolbox usable.
- `close()` aborts active work and disposes owned resources. The injected capability provider and logger are borrowed and are never closed by the toolbox.

Fatal failures such as cancellation, timeout, Worker exit, malformed protocol, or unrecoverable QuickJS failure invalidate the context. The next execution starts with a fresh empty context and the failed source is not retried. Ordinary guest exceptions and provider rejections fail only that execution and preserve the context.

## Persistent state

Guest source is wrapped in an async function. Top-level `await` and `return` work, but top-level declarations are execution-local. Persist state explicitly on `globalThis`:

```js
globalThis.cache = { count: 1 };
globalThis.increment = (value) => value + 1;
return globalThis.cache;
```

Explicit global state survives subsequent `execute()` calls until reset, fatal recovery, or close. Separate Toolbox instances remain isolated.

## Guest API

Every execution receives a fresh capability snapshot. The toolbox replaces `globalThis.mcp` with frozen namespaces and wrappers generated from that snapshot. Retained wrappers still pass through the live provider, which remains responsible for authorization and can reject removed capabilities.

```ts
tools.search(
  query: string,
  options?: { limit?: number },
): Promise<CapabilitySearchResult[]>;

tools.describe(
  reference: { namespace: string; name: string },
): Promise<CapabilityDescription>;

mcp[namespace][capability](input: JsonObject): Promise<JsonValue>;

output(value: JsonValue): void;
```

Use bracket notation for capability names so punctuation, dots, slashes, and other exact names are preserved:

```js
const matches = await tools.search('open pull requests');
const details = await tools.describe(matches[0].reference);
return await mcp[details.reference.namespace][details.reference.name]({
  owner: 'stagewise',
  repo: 'stagewise',
});
```

The frozen `mcp`, `tools`, namespace, and wrapper objects are presentation APIs over the generic `CapabilityProvider`; the Worker does not contain MCP-specific transport or policy logic.

## Execution results

Both `output(value)` and a non-`undefined` resolved return value emit JSON values. Returns are appended after preceding explicit outputs.

| Emissions | Result |
| --- | --- |
| None, including implicit or explicit `undefined` return | `null` |
| One | The value directly |
| Two or more | An array in emission order |

```js
output('starting');
return { done: true };
```

returns:

```json
["starting", { "done": true }]
```

`return null` emits JSON `null`; `return undefined` emits nothing. `output(undefined)` is invalid. Falling off the end emits nothing, and the last expression is not an implicit result.

Every emitted or returned value must be strict JSON: null, booleans, strings, finite numbers, arrays, or plain objects containing only strict JSON. Functions, symbols, bigint, `undefined`, non-finite numbers, cycles, and prototype-bearing objects fail serialization. If evaluation throws, collected emissions are discarded and the execution rejects.

## Isolation and limits

QuickJS receives no ambient Node authority: no `process`, `require`, module loader, filesystem, network, environment, credentials, timers, streams, host objects, or shared memory. External actions are possible only through injected capability wrappers.

Fixed limits are exported as `TOOLBOX_LIMITS`:

- 30-second wall time.
- 64 MiB QuickJS memory.
- 1 MiB QuickJS stack.
- 64 KiB source code.
- 50 provider requests per execution.
- 8 concurrent provider requests.
- 1 MiB serialized provider response.
- 256 KiB normalized execution result.
- 64 MiB Worker old-generation V8 heap and constrained Worker stack.

The result limit applies to the normalized aggregate so repeated small `output()` calls cannot bypass it. JSON validation and byte limits are enforced at Worker and parent boundaries. Worker resource limits are defense in depth; QuickJS and the capability-provider boundary provide the primary guest isolation and authority control.
