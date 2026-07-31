import type { ToolSet } from 'ai';

/**
 * Runtime tool set. All tools are provided by extensions — there are no
 * hardcoded core tools. The `ToolSet` base keeps the merge assignable to
 * AI SDK functions that accept a `ToolSet`.
 */
export type AgentTools = ToolSet;

/**
 * Statically-typed UI tool parts. No core tools are registered statically —
 * all extension-provided tools are dynamically discovered at runtime and
 * flow through `DynamicToolUIPart` in message history.
 */
export type AgentUITools = Record<string, never>;
