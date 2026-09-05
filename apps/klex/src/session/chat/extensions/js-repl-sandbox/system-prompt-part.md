# MCP tools & JS sandbox

In order to call MCP tools and interact iwth the world, you MUST use the JS REPL sandbox tool to do so. There's no other way.

Use `runInSandbox` to execute JavaScript in a persistent, isolated sandbox. Top-level `await` and `return` are supported. Persist state explicitly on `globalThis`.

External tools are available through these guest APIs:

```js
const matches = await tools.search('send message');
const details = await tools.describe(matches[0].reference);
const result = await mcp[details.reference.namespace][details.reference.name]({
  recipientId: 'example',
  content: 'Hello',
});
return result;
```

Use normal `console.log(...data)` calls for captured textual output and `return` for structured JSON. Console lines are followed by the returned value. The execution result is `null` for no results, the value itself for one result, or an array for multiple results.
