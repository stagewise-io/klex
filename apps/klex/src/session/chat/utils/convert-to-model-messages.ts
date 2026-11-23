import {
  convertToModelMessages,
  type DataUIPart,
  type FilePart,
  isToolUIPart,
  type TextPart,
} from 'ai';
import { stringify } from 'yaml';

import type { ContextDataUIPart } from '@/session/inbox';

import type { DataPartTransformers } from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import { quote } from './history-view/lines';
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
): ReturnType<typeof convertToModelMessages> => {
  const materialized = materializeContextParts(messages);
  // Find the last user message index.
  let lastUserMsgIdx = -1;
  for (let i = materialized.length - 1; i >= 0; i--) {
    if (materialized[i]?.role === 'user') {
      lastUserMsgIdx = i;
      break;
    }
  }

  if (lastUserMsgIdx === -1) {
    return projectSandboxToolMedia(
      await convertToModelMessages<ExtendedUIMessage>(materialized, {
        convertDataPart: makeConvertDataPart(transformers),
      }),
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

  return projectSandboxToolMedia(
    await convertToModelMessages<ExtendedUIMessage>(filtered, {
      convertDataPart: makeConvertDataPart(transformers),
    }),
  );
};

// ---------------------------------------------------------------------------
// Built-in core data part transformers
//
// `context`, `continue`, and `check` are core session concepts defined
// in `message-types.ts`. Their transformations are non-negotiable — if
// they were missing, MCP context events, continuation signals, and
// check-retry prompts would be silently dropped. Extensions cannot
// override these.
// ---------------------------------------------------------------------------

function materializeContextParts(
  messages: ExtendedUIMessage[],
): ExtendedUIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap((part) => {
      if (part.type !== 'data-context') return [part];
      return materializeContextPart(part.data);
    }),
  }));
}

function materializeContextPart(
  data: ContextDataUIPart,
): ExtendedUIMessage['parts'] {
  // YAML is presentation only: never parse strings as JSON/YAML, and never
  // wrap long strings. Native media stays in order between the text parts.
  const yaml = (value: unknown): string =>
    quote(
      stringify(value, { lineWidth: 0, aliasDuplicateObjects: false }).replace(
        /\n$/,
        '',
      ),
    ).join('\n');
  const source = JSON.stringify(data.sourceEnv).replace(
    /[\u0085\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const { origin, data: payload, ...envelope } = data.metadata;
  const isMcp = origin === 'events' || origin === 'push-notifications';
  const kind = origin === 'events' ? 'event' : 'push-notification';
  // Delivery IDs stay internal; Events extension metadata is not model context.
  // Payload fields are intentionally untouched, including IDs and nested _meta.
  const fields = isMcp
    ? Object.fromEntries(
        Object.entries(envelope).filter(
          ([key]) =>
            key !== 'eventId' && !(origin === 'events' && key === '_meta'),
        ),
      )
    : {};
  const hasPayload = Object.hasOwn(data.metadata, 'data');
  const body =
    origin === 'events'
      ? hasPayload
        ? `${yaml(payload)}\n`
        : ''
      : isMcp
        ? hasPayload
          ? `${yaml({ metadata: payload })}\n`
          : ''
        : Object.keys(data.metadata).length
          ? `${yaml({ metadata: data.metadata })}\n`
          : '';
  const isPush = origin === 'push-notifications';
  const contentText = (text: string): string =>
    quote(text)
      .map((line) => (isPush ? `¦  ${line.slice(1)}` : line))
      .join('\n');
  const parts: ExtendedUIMessage['parts'] = [
    {
      type: 'text',
      text: `input ${source}${isMcp ? ` ${kind}` : ''}\n${Object.keys(fields).length ? `${yaml(fields)}\n` : ''}data\n${body}${isPush ? (data.content.length ? '¦content:\n' : '¦content: ""\n') : ''}`,
    },
  ];
  for (const block of data.content) {
    if (block.type === 'image' || block.type === 'audio') {
      const mimeType = block.mimeType.toLowerCase();
      parts.push({
        type: 'file',
        mediaType: mimeType,
        url: `data:${mimeType};base64,${block.data}`,
      });
    } else if (
      block.type === 'resource' &&
      block.resource.blob !== undefined &&
      block.resource.mimeType?.trim()
    ) {
      const { blob, ...resource } = block.resource;
      parts.push({
        type: 'text',
        text: `${isPush ? contentText(stringify({ resource }, { lineWidth: 0 }).replace(/\n$/, '')) : yaml({ resource })}\n`,
      });
      const mimeType =
        resource.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ||
        'application/octet-stream';
      parts.push({
        type: 'file',
        mediaType: mimeType,
        url: `data:${mimeType};base64,${blob.replaceAll(/\s/g, '')}`,
      });
    } else {
      parts.push({
        type: 'text',
        text: `${block.type === 'text' ? contentText(block.text) : isPush ? contentText(stringify(block, { lineWidth: 0 }).replace(/\n$/, '')) : yaml(block)}\n`,
      });
    }
  }
  parts.push({ type: 'text', text: '\n' });
  return parts;
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
 * Builds a `convertDataPart` callback for the AI SDK.
 *
 * Core data part types (`context`, `continue`, `check`) are always
 * handled by built-in transformers — extension-registered transformers
 * for these keys are ignored. All other custom types are dispatched to
 * the extension-registered transformer map.
 *
 * The AI SDK calls this function for each custom data part in a message.
 * The part's `type` is `data-{key}` (e.g. `data-context`); we strip the
 * `data-` prefix to look up the corresponding transformer.
 *
 * The extension API returns `(TextPart | FilePart)[]` to allow future
 * multi-part conversions, but the AI SDK's `convertDataPart` accepts
 * only a single `TextPart | FilePart | undefined`. We return the first
 * element of the array, or `undefined` if the array is empty.
 */
function makeConvertDataPart(
  transformers: DataPartTransformers,
): (
  part: DataUIPart<Record<string, unknown>>,
) => TextPart | FilePart | undefined {
  // Per-key occurrence counter, reset for each conversion pass.
  const occurrenceCounts = new Map<string, number>();

  return (part) => {
    // Strip the `data-` prefix to get the data part key.
    const key = part.type.replace(/^data-/, '');

    // Context is materialized into ordered standard UI
    // parts beforehand — the convertDataPart hook never sees them.
    if (key === 'context') return undefined;
    if (key === 'continue') {
      const result = convertContinuePart();
      return result.length > 0 ? result[0] : undefined;
    }
    if (key === 'check') {
      const result = convertCheckPart();
      return result.length > 0 ? result[0] : undefined;
    }

    // Non-core types: dispatch to extension-registered transformers.
    const transformer = transformers[key];
    if (!transformer) return undefined;

    const occurrence = occurrenceCounts.get(key) ?? 0;
    occurrenceCounts.set(key, occurrence + 1);

    const result = transformer(part.data, occurrence);
    return result.length > 0 ? result[0] : undefined;
  };
}
