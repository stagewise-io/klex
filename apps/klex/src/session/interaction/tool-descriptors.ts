import { asSchema, type Tool, type ToolSet } from 'ai';

import type { InteractionToolDescriptor } from './types';

/**
 * Converts a Klex tool set into provider-neutral descriptors. Realtime
 * providers need plain JSON Schema, not the AI SDK's flexible schema
 * wrappers, so the schema is resolved eagerly here.
 *
 * Tools whose schema cannot be resolved are skipped rather than exposed
 * with a broken contract.
 */
export function describeInteractionTools(
  tools: ToolSet,
): InteractionToolDescriptor[] {
  const descriptors: InteractionToolDescriptor[] = [];
  for (const [name, tool] of Object.entries(
    tools as Record<string, Tool | undefined>,
  )) {
    if (!tool) continue;
    let inputSchema: Readonly<Record<string, unknown>>;
    try {
      const resolved = asSchema(tool.inputSchema).jsonSchema;
      if (typeof resolved !== 'object' || resolved === null) continue;
      inputSchema = resolved as Readonly<Record<string, unknown>>;
    } catch {
      continue;
    }
    descriptors.push({
      name,
      ...(typeof tool.description === 'string' && {
        description: tool.description,
      }),
      inputSchema,
    });
  }
  return descriptors;
}
