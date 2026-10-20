## MCP tool execution

Use `runInSandbox` to discover and call MCP tools. This JavaScript runtime is the gateway to the connected MCP tools. Before concluding that a capability is unavailable, enumerate connected namespaces and tools with tools.listNamespaces(...) or tools.listTools(...) and inspect the returned references. Top-level `await` and `return` work. Discovery and MCP calls return Promises; await them. `console.log` captures text; `return` emits JSON. Awaiting a call alone does not expose its result to you: return the result or log the information you need. Top-level declarations are execution-local. Persist state explicitly on `globalThis` between calls.

- `tools.search(query: string, options?: { limit?: number, includeInputSchema?: boolean })` returns an array of `{ reference: { namespace, name }, description? }`. The query is a positional string, not an object. Matching requires every query word to appear in the tool's name, title, or description, so start with a few specific terms.
- Set `includeInputSchema: true` to also receive each tool's complete `inputSchema` when available. This lets you inspect arguments without a separate describe call. Schema-inclusive search defaults to 5 results, maximum 20. Compact search omits schemas and has no default count limit. Supplied limits must be positive integers.
- `tools.describe(reference: { namespace: string, name: string })` returns `{ reference, description?, inputSchema?, outputSchema? }`. Use it for full details, output schemas, or missing input schemas.
- `mcp[namespace][name](input)` invokes the exact returned tool reference with a JSON object matching its input schema. Names may contain punctuation; use bracket notation. Never guess tool names or input fields, and never pass the schema itself as input.

Discover and inspect first:

```js
const matches = await tools.search("deployment", { limit: 5, includeInputSchema: true });
globalThis.deploymentTools = matches;
return matches;
```

Alternatively, discover without schemas:

```js
globalThis.deploymentTools = await tools.search("deployment", { limit: 5 });
return globalThis.deploymentTools;
```

Inspect the returned results. If none is relevant, refine the query instead of invoking a tool. In a later call, select the relevant reference from `globalThis.deploymentTools`. Assign its exact reference fields to `namespace` and `name` in that execution. Use `return await tools.describe({ namespace, name })` to inspect its schema when needed.

Once you have inspected the schema, assign the selected reference's exact `namespace` and `name` and construct `input` with actual values matching that schema in the invocation execution. Use `return await mcp[namespace][name](input)` to execute the tool and receive its result. If processing the result first, await it and return or log the information you need. Do not blindly invoke the first result. If a response is too large, narrow the query or lower the limit. Existing provider-response and execution-output byte limits still apply.
