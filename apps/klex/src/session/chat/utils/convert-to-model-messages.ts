import {
  convertToModelMessages,
  type DataUIPart,
  type FilePart,
  type FileUIPart,
  isToolUIPart,
  type TextPart,
} from 'ai';

import { type ContextDataUIPart, validateInlineImage } from '@/session/inbox';

import type {
  DataPartTransformers,
  ResolvedModel,
} from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';

/**
 * Converts UI messages into the format expected by the model.
 *
 * `data-continue` parts are only meaningful when the preceding message
 * is an assistant message without tool calls — the model needs an
 * explicit prompt to continue a text-only response. In all other cases
 * (user message, assistant with tool calls, or no preceding message),
 * Continue is redundant noise and is stripped from ALL user messages.
 *
 * Messages that become empty after stripping are dropped entirely to
 * avoid sending empty user messages to the model API.
 *
 * Custom data parts are converted using built-in transformers for the
 * core types (`data-context`, `data-continue`) and extension-registered
 * transformers for any additional types. Core type transformers cannot
 * be overridden by extensions — the built-in conversion always applies.
 * Parts whose type has no registered transformer are dropped (the AI
 * SDK's `convertDataPart` returns `undefined`).
 *
 * @param transformers Merged data-part transformers from extensions.
 *   Core types (`context`, `continue`) are always handled by built-in
 *   transformers and are ignored if present here.
 */
export const convertToModelMessagesExtended = async (
  messages: ExtendedUIMessage[],
  transformers: DataPartTransformers,
  resolvedModel: Pick<ResolvedModel, 'inputCapabilities'> = {
    inputCapabilities: {},
  },
): ReturnType<typeof convertToModelMessages> => {
  const materialized = materializeContextParts(messages, resolvedModel);
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

  // Determine whether the last user message's Continue part is needed.
  // Continue is only useful when the preceding message is an assistant
  // message without tool calls — the model needs an explicit prompt to
  // continue a text-only response. Otherwise the Continue is redundant.
  const prevMsg = materialized[lastUserMsgIdx - 1];
  const continueNeeded =
    prevMsg?.role === 'assistant' &&
    !prevMsg.parts.some((p) => isToolUIPart(p));

  const filtered = materialized.flatMap((msg, i) => {
    if (msg.role !== 'user') return [msg];

    // Determine whether to strip Continue from this user message.
    // - Last user message: strip if Continue is not needed.
    // - Older user messages: always strip (only the most recent matters).
    const shouldStripContinue = i === lastUserMsgIdx ? !continueNeeded : true;

    if (
      shouldStripContinue &&
      msg.parts.some((p) => p.type === 'data-continue')
    ) {
      const parts = msg.parts.filter((p) => p.type !== 'data-continue');
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
// `context` and `continue` are core session concepts defined in
// `message-types.ts`. Their transformations are non-negotiable — if they
// were missing, MCP context events and continuation signals would be
// silently dropped. Extensions cannot override these.
// ---------------------------------------------------------------------------

function materializeContextParts(
  messages: ExtendedUIMessage[],
  resolvedModel: Pick<ResolvedModel, 'inputCapabilities'>,
): ExtendedUIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap((part) => {
      if (part.type !== 'data-context') return [part];
      return materializeContextPart(part.data, resolvedModel);
    }),
  }));
}

function materializeContextPart(
  data: ContextDataUIPart,
  resolvedModel: Pick<ResolvedModel, 'inputCapabilities'>,
): ExtendedUIMessage['parts'] {
  const metadata = Object.entries(data.metadata)
    .map(
      ([key, value]) =>
        `<item key="${escapeXml(key)}" value="${escapeXml(String(value))}" />`,
    )
    .join('');
  const parts: ExtendedUIMessage['parts'] = [
    {
      type: 'text',
      text: `<context source-env="${escapeXml(data.sourceEnv)}"><metadata>${metadata}</metadata><content>`,
    },
  ];

  for (const content of data.content) {
    if (content.type === 'text') {
      parts.push({ type: 'text', text: escapeXml(content.text) });
      continue;
    }
    if (content.type !== 'image') continue;

    const imageCapability = resolvedModel.inputCapabilities.image;
    const validation = validateInlineImage(
      content.mimeType,
      content.data,
      imageCapability?.maxBytes,
    );
    const mediaTypeSupported = imageCapability?.mediaTypes.includes(
      content.mimeType,
    );
    if (imageCapability && validation.valid && mediaTypeSupported) {
      const file: FileUIPart = {
        type: 'file',
        mediaType: content.mimeType,
        url: `data:${content.mimeType};base64,${content.data}`,
      };
      parts.push(file);
      continue;
    }

    const reason = !imageCapability
      ? 'model-does-not-support-images'
      : !validation.valid
        ? validation.reason
        : 'unsupported-media-type';
    const decodedBytes = validation.decodedBytes;
    parts.push({
      type: 'text',
      text: `<unsupported-image mime-type="${escapeXml(content.mimeType)}"${decodedBytes === undefined ? '' : ` bytes="${decodedBytes}"`} reason="${reason}" />`,
    });
  }

  parts.push({ type: 'text', text: '</content></context>' });
  return parts;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Transforms a `data-continue` part into the literal text `"Continue."`. */
function convertContinuePart(): TextPart[] {
  return [{ type: 'text', text: 'Continue.' }];
}

/**
 * Builds a `convertDataPart` callback for the AI SDK.
 *
 * Core data part types (`context`, `continue`) are always handled by
 * built-in transformers — extension-registered transformers for these
 * keys are ignored. All other custom types are dispatched to the
 * extension-registered transformer map.
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

    // Context is materialized into ordered standard UI parts beforehand.
    if (key === 'context') return undefined;
    if (key === 'continue') {
      const result = convertContinuePart();
      return result.length > 0 ? result[0] : undefined;
    }

    // Non-core types: dispatch to extension-registered transformers.
    const transformer = transformers[key];
    if (!transformer) return undefined;

    const result = transformer(part.data);
    return result.length > 0 ? result[0] : undefined;
  };
}
