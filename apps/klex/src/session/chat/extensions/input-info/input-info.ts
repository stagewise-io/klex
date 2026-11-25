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
    return 'Structured MCP inputs may expose inputEventRef and moreInfoSections. When needed, use getMoreInputInfo with that reference, an advertised section, and a specific reason explaining which missing facts you need and why. Reasons improve future filters; do not include secrets. raw contains original metadata; content contains original ordered content blocks. Previews may be size-limited regardless of field name. Results are lossless JSON text chunks; follow nextCursor for continuation. References are scoped to this session and expire with retained source history.';
  }
  getTools(): ToolSet {
    return {
      getMoreInputInfo: tool({
        description:
          'Retrieve omitted structured input fields. routing: reply/action routing; objectIds: identifiers; links: extra URLs; other: additional fields; raw: original metadata. Returns bounded JSON text chunks.',
        inputSchema: z.strictObject({
          eventId: z.string().regex(/^[a-z0-9]{8}$/),
          infoSection: z.enum([
            'routing',
            'objectIds',
            'links',
            'other',
            'raw',
            'content',
          ]),
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
        execute: ({ eventId, infoSection, cursor, reason }) =>
          this.allowedReferences && !this.allowedReferences.has(eventId)
            ? Promise.resolve({ status: 'unavailable' })
            : this.projections.readSection(
                this.sessionId,
                eventId,
                infoSection,
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
