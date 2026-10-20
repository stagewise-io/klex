## MCP tool execution

Use `runInSandbox` to discover and call MCP tools. Top-level `await` and `return` work. Discovery and MCP calls return Promises; await them. `console.log` captures text; `return` emits JSON. Awaiting a call alone does not expose its result to you: return the result or log the information you need. Top-level declarations are execution-local. Persist state explicitly on `globalThis` between calls.

- `tools.listNamespaces(options?: { limit?: number })` returns an array of `{ namespace, tools }` from the current runtime snapshot, where `namespace` and each entry in `tools` are the exact `namespace` and `name` strings used with `tools.describe({ namespace, name })` and `mcp[namespace][name](input)`. Use it when you do not know a search term or want to see all connected MCP namespaces and their tool names.
- `tools.listTools(options?: { namespace?: string, limit?: number })` returns an array of `{ reference: { namespace, name } }` from the current runtime snapshot, optionally filtered to a non-empty `namespace` and bounded by a positive integer `limit`. Each returned `reference` contains the exact `namespace` and `name` used with `tools.describe({ namespace, name })` and `mcp[namespace][name](input)`.
- `tools.search(query: string, options?: { limit?: number, includeInputSchema?: boolean })` returns an array of `{ reference: { namespace, name }, description? }`. The query is a non-empty positional string, not an object; empty or whitespace-only queries are rejected, so use `tools.listNamespaces()` or `tools.listTools()` to enumerate all tools without a search term. Matching requires every query word to appear in the tool's name, title, or description, so start with a few specific terms.
- Set `includeInputSchema: true` to also receive each tool's complete `inputSchema` when available. This lets you inspect arguments without a separate describe call. Schema-inclusive search defaults to 5 results, maximum 20. Compact search omits schemas and has no default count limit. Supplied limits must be positive integers.
- `tools.describe(reference: { namespace: string, name: string })` returns `{ reference, description?, inputSchema?, outputSchema? }`. Use it for full details, output schemas, or missing input schemas.
- `mcp[namespace][name](input)` invokes the exact returned tool reference with a JSON object matching its input schema. Names may contain punctuation; use bracket notation. Never guess tool names or input fields, and never pass the schema itself as input.

When you do not know which namespace or search term to use, enumerate namespaces or tools first:

```js
globalThis.namespaces = await tools.listNamespaces();
globalThis.availableTools = await tools.listTools({ limit: 20 });
return {
  namespaces: globalThis.namespaces,
  availableTools: globalThis.availableTools,
};
```

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

Inspect the returned results. If none is relevant, refine the query or enumerate with `tools.listNamespaces()` / `tools.listTools()` instead of invoking a tool. In a later call, select the relevant reference from `globalThis.deploymentTools` or `globalThis.availableTools`. Assign its exact reference fields to `namespace` and `name` in that execution. Use `return await tools.describe({ namespace, name })` to inspect its schema when needed.

Once you have inspected the schema, assign the selected reference's exact `namespace` and `name` and construct `input` with actual values matching that schema in the invocation execution. Use `return await mcp[namespace][name](input)` to execute the tool and receive its result. If processing the result first, await it and return or log the information you need. Do not blindly invoke the first result. If a response is too large, narrow the query or lower the limit. Existing provider-response and execution-output byte limits still apply.
