import { type ToolSet, tool } from 'ai';
import z from 'zod';

import {
  blockPartTransformer,
  createDataPart,
  type ExtensionDeps,
  type ExtensionFactory,
  type HistoryTransformOptions,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  contextBlock,
  type DataBlock,
  field,
} from '@/session/chat/utils/history-view';
import type { ContextDataUIPart } from '@/session/inbox';

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

class InputFilterModule {
  private readonly projections: InputProjections;
  private readonly references = new Map<string, string>();
  constructor(
    private readonly deps: ExtensionDeps,
    private readonly repository?: ProjectionRepository,
    private readonly enabled = true,
  ) {
    this.projections = createInputProjections(repository);
  }
  onStart = () => this.projections.start();
  onClose = async () => {
    this.references.clear();
    await this.projections.close();
  };
  introspect = () => this.projections.diagnostics();
  dataPartTransformers = { [KEY]: blockPartTransformer<FilteredInput>(blocks) };

  transform(
    history: ExtendedUIMessage[],
    options: HistoryTransformOptions = { purpose: 'inference' },
  ): ExtendedUIMessage[] | Promise<ExtendedUIMessage[]> {
    if (!this.enabled || !this.repository) return history;
    return this.projectHistory(history, options);
  }

  private async projectHistory(
    history: ExtendedUIMessage[],
    options: HistoryTransformOptions,
  ): Promise<ExtendedUIMessage[]> {
    const memory = this.deps.config.getModelSelection?.('memory') ?? [];
    // A storage failure cannot safely produce a bounded preview with recovery.
    // Propagate it so the consumer aborts preparation rather than sending raw data.
    await this.projections.prepare(
      this.deps.sessionId,
      history,
      options.purpose === 'inference'
        ? {
            generate: this.deps.generateText,
            modelIds: memory.length
              ? memory
              : (this.deps.config.getModelSelection?.('chat') ?? []),
            signal: options.signal,
          }
        : undefined,
    );
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
        if (!eventRef) {
          const origin = part.data.metadata.origin;
          if (origin === 'events' || origin === 'push-notifications')
            throw new Error('Input event recovery binding unavailable');
          return part;
        }
        this.references.set(JSON.stringify([message.id, partIndex]), eventRef);
        if (this.references.size > 2_048)
          this.references.delete(this.references.keys().next().value!);
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
    this.enabled ? recoveryTools(this.projections, this.deps.sessionId) : {};
  getChildContextExtensions(
    history: readonly ExtendedUIMessage[],
  ): ExtensionFactory[] {
    if (!this.enabled) return [];
    const allowed = new Set<string>();
    for (const message of history) {
      for (const part of message.parts) {
        if ((part.type as string) !== `data-${KEY}`) continue;
        const data = (part as unknown as { data: FilteredInput }).data;
        if (
          this.references.get(
            JSON.stringify([message.id, message.parts.indexOf(part)]),
          ) === data.eventRef
        )
          allowed.add(data.eventRef);
      }
    }
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

export function createInputFilter(
  deps: ExtensionDeps,
  repository?: ProjectionRepository,
  enabled = true,
) {
  return new InputFilterModule(deps, repository, enabled);
}
