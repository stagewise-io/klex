export const getSystemPromptPart = (maxConcurrentWindows: number): string => {
  return `
## MCP Resources

Use \`listResources\` to discover resources (data, conversations, sources, etc.) from MCP servers. Use \`openResource\` to open a resource into a window. Resources appear in \`<resource>\` blocks in the conversation.

A "live resource" auto-updates — changes are given to you automatically in \`<resource>\` blocks. Other resources need a refresh through another \`openResource\` call.

Up to ${maxConcurrentWindows} resource windows open at once. Use \`closeResource\` to close a resource before opening a new one. Always close windows when no longer needed.

The list of connected MCP servers is provided in \`<mcp-servers>\` blocks, with diffs when servers connect or disconnect.
`.trim();
};
