import { type ToolSet, tool } from 'ai';
import z from 'zod';

import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  contextBlock,
  type DataBlock,
  field,
} from '@/session/chat/utils/history-view';
import type { ContextDataUIPart } from '@/session/inbox';

import {
  blockPartTransformer,
  createDataPart,
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  type ModelHistoryProjection,
} from '../extension-api';
import {
  createInputProjections,
  type InputProjections,
  type ProjectionRepository,
} from './input-projections';

const KEY = 'filtered-input';
interface FilteredInput {
  eventRef: string;
  event: ContextDataUIPart;
}

function blocks({ eventRef, event }: FilteredInput): DataBlock[] {
  const body = contextBlock(event);
  return [
    {
      type: KEY,
      fields: [
        field('eventRef', eventRef, 'trusted'),
        {
          key: 'event',
          kind: 'sequence',
          items: 'fields' in body ? (body.fields ?? []) : [],
        },
      ],
    },
  ];
}

class InputFilterExtension implements Extension {
  private readonly projections: InputProjections;
  private readonly references = new Set<string>();
  constructor(
    private readonly deps: ExtensionDeps,
    repository: ProjectionRepository,
  ) {
    this.projections = createInputProjections(repository);
  }
  onStart = () => this.projections.start();
  onClose = () => this.projections.close();
  introspect = () => this.projections.diagnostics();
  dataPartTransformers = { [KEY]: blockPartTransformer<FilteredInput>(blocks) };

  async projectModelHistory(
    history: ExtendedUIMessage[],
    options: ModelHistoryProjection,
  ): Promise<ExtendedUIMessage[]> {
    const memory = this.deps.config.getModelSelection('memory');
    try {
      await this.projections.prepare(
        this.deps.sessionId,
        history,
        options.purpose === 'inference'
          ? {
              generate: this.deps.generateText,
              modelIds: memory.length
                ? memory
                : this.deps.config.getModelSelection('chat'),
              signal: options.signal,
            }
          : undefined,
      );
    } catch {
      return history;
    }
    return history.map((message) => ({
      ...message,
      parts: message.parts.map((part, partIndex) => {
        if (part.type !== 'data-context') return part;
        const occurrence = { messageId: message.id, partIndex };
        const eventRef = this.projections.reference(
          this.deps.sessionId,
          part.data,
          occurrence,
        );
        if (!eventRef) return part;
        this.references.add(eventRef);
        return createDataPart(KEY, {
          eventRef,
          event: this.projections.present(
            this.deps.sessionId,
            part.data,
            occurrence,
          ),
        }) as unknown as ExtendedUIMessage['parts'][number];
      }),
    }));
  }
  getTools = (): ToolSet =>
    recoveryTools(this.projections, this.deps.sessionId);
  getChildContextExtensions(context: string): ExtensionFactory[] {
    const allowed = new Set(
      [...this.references].filter((reference) =>
        context.includes(`eventRef: ${reference}`),
      ),
    );
    if (!allowed.size) return [];
    return [
      {
        identifier: 'io.stagewise/input-filter-recovery',
        create: () => ({
          getTools: () =>
            recoveryTools(this.projections, this.deps.sessionId, allowed),
        }),
      },
    ];
  }
}

function recoveryTools(
  projections: InputProjections,
  sessionId: string,
  allowed?: ReadonlySet<string>,
): ToolSet {
  return {
    getUnfilteredInput: tool({
      description:
        'Structured MCP events and push notifications in filtered-input wrappers may omit fields or limit values. When missing facts are necessary, pass the wrapper eventRef as eventId and explain which information is needed and why. Retrieves the complete original sourceEnv, metadata and ordered content without changing future filtered context. Results are lossless JSON text chunks; follow nextCursor using cursor until null to reconstruct large events. References are session-scoped and expire with retained history. Reasons improve future filters; do not include secrets.',
      inputSchema: z.strictObject({
        eventId: z.string().regex(/^[a-z0-9]{8}$/),
        reason: z.string().trim().min(1).max(1_000),
        cursor: z.string().max(256).optional(),
      }),
      execute: ({ eventId, reason, cursor }) =>
        allowed && !allowed.has(eventId)
          ? Promise.resolve({ status: 'unavailable' })
          : projections.readUnfiltered(sessionId, eventId, cursor, reason),
    }),
  };
}

export function createInputFilterExt(
  repository: ProjectionRepository,
): ExtensionFactory {
  return {
    identifier: 'io.stagewise/input-filter',
    create: (deps) => new InputFilterExtension(deps, repository),
  };
}
