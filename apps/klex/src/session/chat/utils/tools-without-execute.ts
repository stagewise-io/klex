import type { ToolSet } from 'ai';

/**
 * Strips the `execute` function from every tool in a tool set,
 * setting it to `undefined`. All other properties (inputSchema,
 * outputSchema, description, etc.) are preserved.
 *
 * The original tool set is not mutated — a shallow copy of each
 * tool is created with the `execute` property overridden.
 */
export const toolsWithoutExecute = <T extends ToolSet>(tools: T): T =>
  Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      { ...tool, execute: undefined },
    ]),
  ) as T;
