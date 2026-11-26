import { type ToolSet, tool } from 'ai';
import z from 'zod';

import type { InputProjections } from '@/input-projections';

import type { Extension, ExtensionFactory } from '../extension-api';

class InputInfoExtension implements Extension {
  constructor(
    private readonly projections: InputProjections,
    private readonly sessionId: string,
    private readonly allowedReferences?: ReadonlySet<string>,
  ) {}
  getSystemPromptPart(): string {
    return 'Structured MCP inputs may be filtered or size-limited and expose inputEventRef. When omitted facts are needed, use getUnfilteredInput with that reference and a specific reason explaining what is missing and why it is needed. The tool returns the complete original event (sourceEnv, metadata and ordered content) once; future context stays filtered. Reasons improve future filters; do not include secrets. Results are lossless JSON text chunks; use nextCursor only when a large event requires continuation. References are scoped to this session and expire with retained source history.';
  }
  getTools(): ToolSet {
    return {
      getUnfilteredInput: tool({
        description:
          'Retrieve the complete original unfiltered event once, without changing future context. Returns lossless JSON text chunks; follow nextCursor only for oversized events.',
        inputSchema: z.strictObject({
          eventId: z.string().regex(/^[a-z0-9]{8}$/),
          reason: z
            .string()
            .trim()
            .min(1)
            .max(1_000)
            .describe(
              'Explain which missing information is needed and why it is necessary for the current task.',
            ),
          cursor: z.string().max(256).optional(),
        }),
        execute: ({ eventId, cursor, reason }) =>
          this.allowedReferences && !this.allowedReferences.has(eventId)
            ? Promise.resolve({ status: 'unavailable' })
            : this.projections.readUnfiltered(
                this.sessionId,
                eventId,
                cursor,
                reason,
              ),
      }),
    };
  }
}
export function createInputInfoExt(
  projections: InputProjections,
  sessionId?: string,
  allowedReferences?: ReadonlySet<string>,
): ExtensionFactory {
  return {
    identifier: 'io.stagewise/input-info',
    create: (deps) =>
      new InputInfoExtension(
        projections,
        sessionId ?? deps.sessionId,
        allowedReferences,
      ),
  };
}
