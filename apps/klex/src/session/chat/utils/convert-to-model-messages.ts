import {
  convertToModelMessages,
  type DataUIPart,
  type FilePart,
  isToolUIPart,
  type ModelMessage,
  type TextPart,
} from 'ai';

import {
  materializeMemories,
  materializeSkills,
} from '@/session/chat/extensions/memory/loading';
import { recallAnswerText } from '@/session/chat/extensions/memory/recall';
import type { ContextDataUIPart } from '@/session/inbox';

import type { DataPartTransformers } from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import { createDataPartDispatcher, renderBlockSegments } from './history-view';
import { contextBlock } from './history-view/context-block';
import { projectSandboxToolMedia } from './project-sandbox-media';

/**
 * Converts UI messages into the format expected by the model.
 *
 * `data-continue` and `data-check` parts are only meaningful when the preceding message
 * is an assistant message without tool calls — the model needs an
 * explicit prompt to continue a text-only response. In all other cases
 * (user message, assistant with tool calls, or no preceding message),
 * Continue is redundant noise and is stripped from ALL user messages.
 *
 * Messages that become empty after stripping are dropped entirely to
 * avoid sending empty user messages to the model API.
 *
 * Custom data parts are converted using built-in transformers for the
 * core types (`data-context`, `data-continue`,
 * `data-check`) and extension-registered transformers for any additional
 * types. Core type transformers cannot be overridden by extensions — the
 * built-in conversion always applies.
 * Parts whose type has no registered transformer are dropped (the AI
 * SDK's `convertDataPart` returns `undefined`).
 *
 * @param transformers Merged data-part transformers from extensions.
 *   Core types (`context`, `continue`, `check`) are always
 *   handled by built-in transformers and are ignored if present here.
 */
export const convertToModelMessagesExtended = async (
  messages: ExtendedUIMessage[],
  transformers: DataPartTransformers,
  onMemoryMetrics?: Parameters<typeof materializeMemories>[1],
  projectContext?: (context: ContextDataUIPart) => ContextDataUIPart,
): ReturnType<typeof convertToModelMessages> => {
  const materialized = materializeContextParts(messages, projectContext);
  // Find the last user message index.
  let lastUserMsgIdx = -1;
  for (let i = materialized.length - 1; i >= 0; i--) {
    if (materialized[i]?.role === 'user') {
      lastUserMsgIdx = i;
      break;
    }
  }

  if (lastUserMsgIdx === -1) {
    return projectRecallResults(
      projectSandboxToolMedia(
        await convertToModelMessages<ExtendedUIMessage>(
          materializeExtensionParts(
            materializeMemories(
              materializeSkills(materialized),
              onMemoryMetrics,
            ),
            transformers,
          ),
          {
            convertDataPart: convertCoreDataPart,
          },
        ),
      ),
    );
  }

  // Determine whether the last user message's signal part is needed.
  // Signal parts (data-continue, data-check) are only useful when the
  // preceding message is an assistant message without tool calls — the
  // model needs an explicit prompt to continue or check. Otherwise the
  // signal is redundant.
  const prevMsg = materialized[lastUserMsgIdx - 1];
  const signalNeeded =
    prevMsg?.role === 'assistant' &&
    !prevMsg.parts.some((p) => isToolUIPart(p));

  const filtered = materialized.flatMap((msg, i) => {
    if (msg.role !== 'user') return [msg];

    // Determine whether to strip signal parts from this user message.
    // - Last user message: strip if the signal is not needed.
    // - Older user messages: always strip (only the most recent matters).
    const shouldStripSignals = i === lastUserMsgIdx ? !signalNeeded : true;

    if (
      shouldStripSignals &&
      (msg.parts.some((p) => p.type === 'data-continue') ||
        msg.parts.some((p) => p.type === 'data-check'))
    ) {
      const parts = msg.parts.filter(
        (p) => p.type !== 'data-continue' && p.type !== 'data-check',
      );
      return parts.length > 0 ? [{ ...msg, parts }] : [];
    }

    return [msg];
  });

  return projectRecallResults(
    projectSandboxToolMedia(
      await convertToModelMessages<ExtendedUIMessage>(
        materializeExtensionParts(
          materializeMemories(materializeSkills(filtered), onMemoryMetrics),
          transformers,
        ),
        {
          convertDataPart: convertCoreDataPart,
        },
      ),
    ),
  );
};

function projectRecallResults(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) =>
    message.role !== 'tool'
      ? message
      : {
          ...message,
          content: message.content.map((part) => {
            if (part.type !== 'tool-result' || part.output.type !== 'json')
              return part;
            const text = recallAnswerText(part.toolName, part.output.value);
            return text === null
              ? part
              : { ...part, output: { type: 'text' as const, value: text } };
          }),
        },
  );
}

// ---------------------------------------------------------------------------
// Built-in core data part transformers
//
// `context`, `continue`, and `check` are core session concepts defined
// in `message-types.ts`. Their transformations are non-negotiable — if
// they were missing, MCP context events, continuation signals, and
// check-retry prompts would be silently dropped. Extensions cannot
// override these.
// ---------------------------------------------------------------------------

function materializeExtensionParts(
  messages: ExtendedUIMessage[],
  transformers: DataPartTransformers,
): ExtendedUIMessage[] {
  const dispatcher = createDataPartDispatcher(transformers);
  return messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap<ExtendedUIMessage['parts'][number]>((part) => {
      const occurrence = dispatcher.consume(part);
      if (!part.type.startsWith('data-')) return [part];
      const key = part.type.slice(5);
      if (['context', 'continue', 'check'].includes(key)) return [part];
      const transform = transformers[key];
      if (!transform) return [part];
      return dispatcher
        .materialize(key, (part as { data: unknown }).data, occurrence)
        .map((item) =>
          item.type === 'text'
            ? { type: 'text' as const, text: item.text }
            : {
                type: 'file' as const,
                mediaType: item.mediaType,
                url:
                  item.data instanceof URL ||
                  (typeof item.data === 'string' &&
                    /^(https?:|data:)/.test(item.data))
                    ? String(item.data)
                    : `data:${item.mediaType};base64,${typeof item.data === 'string' ? item.data : Buffer.from(item.data as Uint8Array).toString('base64')}`,
              },
        );
    }),
  }));
}

function materializeContextParts(
  messages: ExtendedUIMessage[],
  projectContext?: (context: ContextDataUIPart) => ContextDataUIPart,
): ExtendedUIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap((part) => {
      if (part.type !== 'data-context') return [part];
      return materializeContextPart(projectContext?.(part.data) ?? part.data);
    }),
  }));
}

function materializeContextPart(
  data: ContextDataUIPart,
): ExtendedUIMessage['parts'] {
  return renderBlockSegments(contextBlock(data)).map((segment) =>
    segment.type === 'text'
      ? segment
      : {
          type: 'file' as const,
          mediaType: segment.mediaType,
          url: `data:${segment.mediaType};base64,${segment.data}`,
        },
  );
}

/** Transforms a `data-continue` part into the literal text `"Continue."`. */
function convertContinuePart(): TextPart[] {
  return [{ type: 'text', text: 'Continue.' }];
}

/** Transforms a `data-check` part into a review prompt. */
function convertCheckPart(): TextPart[] {
  return [
    {
      type: 'text',
      text: 'New data appeared before you finished your output. Check if you need to take any actions or responses. Do nothing, if nothing relevant happened.',
    },
  ];
}

/**
 * Handles core signals after multipart context/extension materialization.
 * Unknown parts are deliberately omitted by the SDK.
 */
function convertCoreDataPart(
  part: DataUIPart<Record<string, unknown>>,
): TextPart | FilePart | undefined {
  if (part.type === 'data-continue') return convertContinuePart()[0];
  if (part.type === 'data-check') return convertCheckPart()[0];
  return undefined;
}
