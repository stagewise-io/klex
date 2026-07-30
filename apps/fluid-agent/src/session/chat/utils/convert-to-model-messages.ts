import {
  convertToModelMessages,
  type DataUIPart,
  type FilePart,
  isToolUIPart,
  type TextPart,
} from 'ai';

import type { DataPartTransformers } from '../extensions/extension-api';
import type { CustomUIDataParts, ExtendedUIMessage } from '../message-types';

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
 * Custom data parts are converted using the transformers registered by
 * extensions (collected via `ExtensionHandler.getDataPartTransformers`).
 * Parts whose type has no registered transformer are dropped (the AI
 * SDK's `convertDataPart` returns `undefined`).
 *
 * @param transformers Merged data-part transformers from all extensions.
 */
export const convertToModelMessagesExtended = async (
  messages: ExtendedUIMessage[],
  transformers: DataPartTransformers,
): ReturnType<typeof convertToModelMessages> => {
  // Find the last user message index.
  let lastUserMsgIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserMsgIdx = i;
      break;
    }
  }

  if (lastUserMsgIdx === -1) {
    return convertToModelMessages<ExtendedUIMessage>(messages, {
      convertDataPart: makeConvertDataPart(transformers),
    });
  }

  // Determine whether the last user message's Continue part is needed.
  // Continue is only useful when the preceding message is an assistant
  // message without tool calls — the model needs an explicit prompt to
  // continue a text-only response. Otherwise the Continue is redundant.
  const prevMsg = messages[lastUserMsgIdx - 1];
  const continueNeeded =
    prevMsg?.role === 'assistant' &&
    !prevMsg.parts.some((p) => isToolUIPart(p));

  const filtered = messages.flatMap((msg, i) => {
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

/**
 * Builds a `convertDataPart` callback for the AI SDK from the
 * extension-registered transformers.
 *
 * The AI SDK calls this function for each custom data part in a message.
 * The part's `type` is `data-{key}` (e.g. `data-context`); we strip the
 * `data-` prefix to look up the corresponding transformer in the
 * `DataPartTransformers` map (whose keys are `CustomUIDataParts` keys
 * without the prefix).
 *
 * The extension API returns `(TextPart | FilePart)[]` to allow future
 * multi-part conversions, but the AI SDK's `convertDataPart` accepts
 * only a single `TextPart | FilePart | undefined`. We return the first
 * element of the array, or `undefined` if the array is empty.
 */
function makeConvertDataPart(
  transformers: DataPartTransformers,
): (part: DataUIPart<CustomUIDataParts>) => TextPart | FilePart | undefined {
  return (part) => {
    // Strip the `data-` prefix to get the CustomUIDataParts key.
    const key = part.type.replace(/^data-/, '') as keyof CustomUIDataParts;
    const transformer = transformers[key];
    if (!transformer) return undefined;

    // The mapped type makes per-key call structurally impossible —
    // cast through a loose function type to invoke the transformer.
    const fn = transformer as (
      data: typeof part.data,
    ) => (TextPart | FilePart)[];
    const result = fn(part.data);
    return result.length > 0 ? result[0] : undefined;
  };
}
