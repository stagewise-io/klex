export const getSystemPromptPart = (maxConcurrentWindows: number): string => {
  return `
## MCP Resources

Use \`addMcpServer\` with a name, URL, and optional headers to add a new remote HTTP/HTTPS MCP server to config.json. This is append-only: it cannot edit or remove existing servers, and each name must be unique after trimming surrounding whitespace. Names must be nonblank, contain no control characters, and cannot be reserved JavaScript object names such as __proto__, constructor, or prototype. Tool output includes only name, type, URL, sorted headerNames, and current connection status; it never echoes secret header values. If the remote server requires OAuth, the user can authorize it in the Cloud UI after it is added.

Use \`listResources\` to discover resources (data, conversations, sources, etc.) from MCP servers. Use \`openResource\` to open a resource into a window. Resources appear in \`<resource>\` blocks in the conversation.

A "live resource" auto-updates — changes are given to you automatically in \`<resource>\` blocks. Other resources need a refresh through another \`openResource\` call.

Up to ${maxConcurrentWindows} resource windows open at once. Use \`closeResource\` to close a resource before opening a new one. Always close windows when no longer needed.

The list of connected MCP servers is provided in \`<mcp-servers>\` blocks, with diffs when servers connect or disconnect.
`.trim();
};
