## MCP tool execution

Use `runInSandbox` to discover and call MCP tools. Top-level `await` and `return` work. `console.log` captures text; `return` emits JSON. Persist state explicitly on `globalThis` between calls.

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

For compact discovery, use `await tools.search("deployment", { limit: 5 })`, then `await tools.describe(matches[0].reference)` after checking that matches is non-empty and selecting a relevant tool. Equivalently, `await tools.describe({ namespace, name })` accepts names from a returned reference.

In a later call, select the relevant returned reference and invoke `await mcp[namespace][name](input)` using actual values for the fields you inspected. Do not blindly invoke the first result. If a response is too large, narrow the query or lower the limit. Existing provider-response and execution-output byte limits still apply.
