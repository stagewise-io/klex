import {
  convertToModelMessages,
  type DataUIPart,
  type FilePart,
  isToolUIPart,
  type TextPart,
} from 'ai';

import type { ContextDataUIPart } from '@/session/inbox';

import type { DataPartTransformers } from '../extensions/extension-api';
import type { ExtendedUIMessage, GodMessageDataUIPart } from '../message-types';

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
 * core types (`data-context`, `data-god-message`, `data-continue`,
 * `data-check`) and extension-registered transformers for any additional
 * types. Core type transformers cannot be overridden by extensions — the
 * built-in conversion always applies.
 * Parts whose type has no registered transformer are dropped (the AI
 * SDK's `convertDataPart` returns `undefined`).
 *
 * @param transformers Merged data-part transformers from extensions.
 *   Core types (`context`, `god-message`, `continue`, `check`) are always
 *   handled by built-in transformers and are ignored if present here.
 */
export const convertToModelMessagesExtended = async (
  messages: ExtendedUIMessage[],
  transformers: DataPartTransformers,
): ReturnType<typeof convertToModelMessages> => {
  const materialized = materializeGodMessageParts(
    materializeContextParts(messages),
  );
  // Find the last user message index.
  let lastUserMsgIdx = -1;
  for (let i = materialized.length - 1; i >= 0; i--) {
    if (materialized[i]?.role === 'user') {
      lastUserMsgIdx = i;
      break;
    }
  }

  if (lastUserMsgIdx === -1) {
    return convertToModelMessages<ExtendedUIMessage>(materialized, {
      convertDataPart: makeConvertDataPart(transformers),
    });
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

  return convertToModelMessages<ExtendedUIMessage>(filtered, {
    convertDataPart: makeConvertDataPart(transformers),
  });
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

function materializeGodMessageParts(
  messages: ExtendedUIMessage[],
): ExtendedUIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap((part) => {
      if (part.type !== 'data-god-message') return [part];
      return materializeGodMessagePart(part.data);
    }),
  }));
}

/**
 * Materializes shared content blocks (text, image, audio, resource_link,
 * resource) into ordered standard UI parts. Used by both
 * {@link materializeContextPart} and {@link materializeGodMessagePart}.
 */
function materializeContentBlocks(
  content: ContextDataUIPart['content'],
): ExtendedUIMessage['parts'] {
  const parts: ExtendedUIMessage['parts'] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({
        type: 'text',
        text: `<text>${escapeXmlText(block.text)}</text>`,
      });
      continue;
    }

    if (block.type === 'image') {
      const normalizedMimeType = block.mimeType.toLowerCase();
      parts.push({
        type: 'text',
        text: `<image>`,
      });
      parts.push({
        type: 'file',
        mediaType: normalizedMimeType,
        url: `data:${normalizedMimeType};base64,${block.data}`,
      });
      parts.push({ type: 'text', text: '</image>' });
      continue;
    }

    if (block.type === 'audio') {
      const normalizedMimeType = block.mimeType.toLowerCase();
      parts.push({
        type: 'text',
        text: `<audio>`,
      });
      parts.push({
        type: 'file',
        mediaType: normalizedMimeType,
        url: `data:${normalizedMimeType};base64,${block.data}`,
      });
      parts.push({ type: 'text', text: '</audio>' });
      continue;
    }

    if (block.type === 'resource_link') {
      const attrs = [
        `uri="${escapeXmlAttr(block.uri)}"`,
        `name="${escapeXmlAttr(block.name)}"`,
      ];
      if (block.title) attrs.push(`title="${escapeXmlAttr(block.title)}"`);
      if (block.description)
        attrs.push(`description="${escapeXmlAttr(block.description)}"`);
      if (block.mimeType)
        attrs.push(`mime-type="${escapeXmlAttr(block.mimeType)}"`);
      if (block.size !== undefined) attrs.push(`size="${block.size}"`);
      parts.push({
        type: 'text',
        text: `<resource-link ${attrs.join(' ')} />`,
      });
      continue;
    }

    if (block.type === 'resource') {
      const res = block.resource;
      const attrs = [`uri="${escapeXmlAttr(res.uri)}"`];
      if (res.mimeType)
        attrs.push(`mime-type="${escapeXmlAttr(res.mimeType)}"`);
      parts.push({
        type: 'text',
        text: `<resource ${attrs.join(' ')}>`,
      });
      if (res.text !== undefined) {
        parts.push({
          type: 'text',
          text: `<text>${escapeXmlText(res.text)}</text>`,
        });
      } else if (res.blob !== undefined && res.mimeType?.trim()) {
        const normalizedMimeType = res.mimeType.trim().toLowerCase();
        parts.push({
          type: 'file',
          mediaType: normalizedMimeType,
          url: `data:${normalizedMimeType};base64,${res.blob.replaceAll(/\s/g, '')}`,
        });
      } else if (res.blob !== undefined) {
        parts.push({
          type: 'text',
          text: `<blob>${escapeXmlText(res.blob)}</blob>`,
        });
      }
      parts.push({ type: 'text', text: '</resource>' });
    }
  }
  return parts;
}

/**
 * Materializes a `data-god-message` part into ordered standard UI parts.
 * Uses a `<god-message>` wrapper with no metadata section — god messages
 * carry no environment metadata.
 */
function materializeGodMessagePart(
  data: GodMessageDataUIPart,
): ExtendedUIMessage['parts'] {
  return [
    { type: 'text', text: '<god-message>' },
    ...materializeContentBlocks(data.content),
    { type: 'text', text: '</god-message>' },
  ];
}

function materializeContextPart(
  data: ContextDataUIPart,
): ExtendedUIMessage['parts'] {
  const metadata = escapeXmlText(JSON.stringify(data.metadata));
  return [
    {
      type: 'text',
      text: `<context source-env="${escapeXmlAttr(data.sourceEnv)}"><metadata>${metadata}</metadata><content>`,
    },
    ...materializeContentBlocks(data.content),
    { type: 'text', text: '</content></context>' },
  ];
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
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
 * Core data part types (`context`, `god-message`, `continue`, `check`) are always
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
  return (part) => {
    // Strip the `data-` prefix to get the data part key.
    const key = part.type.replace(/^data-/, '');

    // Context and god-message are materialized into ordered standard UI
    // parts beforehand — the convertDataPart hook never sees them.
    if (key === 'context') return undefined;
    if (key === 'god-message') return undefined;
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

    const result = transformer(part.data);
    return result.length > 0 ? result[0] : undefined;
  };
}
