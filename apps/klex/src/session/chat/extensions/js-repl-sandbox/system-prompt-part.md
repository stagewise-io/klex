# MCP

Use `runInSandbox` for all MCP interaction. Never guess tool names or inputs.

Use these calls inside `runInSandbox`:

1. `return await tools.search("reply to a message");` searches available tools. Supply a nonempty query, such as the source environment or the action you need.
2. `return await tools.describe({ namespace: "<namespace from search>", name: "<name from search>" });` returns the tool's input schema.
3. `return await mcp["<namespace>"]["<name>"]({ /* inputs matching that schema */ });` executes the tool. Use the incoming message's metadata for its destination and event identifiers.

Search and describe only provide information. To communicate with the sender, continue to the actual send or reply call and check its result. `console.log` and `return` only show results to you; they do not send messages.
