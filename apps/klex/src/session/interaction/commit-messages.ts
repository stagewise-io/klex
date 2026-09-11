import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { ContextDataUIPart } from '@/session/inbox';

import type { RealtimeCommitEvent } from './types';

/**
 * Source environment recorded on canonical history entries that were
 * produced by a leased realtime interaction.
 */
export const REALTIME_SOURCE_ENV = 'realtime-voice';

function contextMessage(
  id: string,
  metadata: ContextDataUIPart['metadata'],
  text: string,
): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [
      {
        type: 'data-context',
        data: {
          sourceEnv: REALTIME_SOURCE_ENV,
          metadata,
          content: [{ type: 'text', text }],
        },
      },
    ],
  };
}

/**
 * Projects a realtime commit event onto canonical chat history.
 *
 * Transcripts become real user/assistant turns so a later chat generation
 * reads the call as ordinary conversation. Lifecycle and tool activity
 * become context entries — they are call machinery, not spoken turns.
 */
export function toCanonicalMessage(
  event: RealtimeCommitEvent,
): ExtendedUIMessage {
  switch (event.type) {
    case 'user-transcript':
      return {
        id: event.eventId,
        role: 'user',
        parts: [{ type: 'text', text: event.text }],
      };
    case 'assistant-transcript':
      return {
        id: event.eventId,
        role: 'assistant',
        parts: [{ type: 'text', text: event.text }],
      };
    case 'session-started':
      return contextMessage(
        event.eventId,
        { kind: 'realtime-session-started', timestamp: event.timestamp },
        'A realtime voice call started. Spoken turns are appended to this conversation.',
      );
    case 'session-ended':
      return contextMessage(
        event.eventId,
        {
          kind: 'realtime-session-ended',
          timestamp: event.timestamp,
          ...(event.reason !== undefined && { reason: event.reason }),
        },
        `The realtime voice call ended${event.reason ? ` (${event.reason})` : ''}.`,
      );
    case 'tool-call':
      return contextMessage(
        event.eventId,
        {
          kind: 'realtime-tool-call',
          timestamp: event.timestamp,
          toolName: event.request.name,
          executionId: event.request.executionId,
        },
        `Tool ${event.request.name} was called during the call with input ${JSON.stringify(event.request.input)}.`,
      );
    case 'tool-result':
      return contextMessage(
        event.eventId,
        {
          kind: 'realtime-tool-result',
          timestamp: event.timestamp,
          executionId: event.result.executionId,
          status: event.result.status,
        },
        event.result.status === 'success'
          ? `Tool result: ${JSON.stringify(event.result.output)}`
          : `Tool failed (${event.result.code}): ${event.result.error}`,
      );
  }
}
