import {
  convertToModelMessages,
  type DataUIPart,
  type FilePart,
  type TextPart,
} from 'ai';

import type { CustomUIDataParts, ExtendedUIMessage } from '@/session/types';

/**
 * Converts UI messages into the format expected by the model.
 *
 * Strips `data-continue` parts from all user messages except the last
 * user message. Continue messages accumulate during salvage loops; only
 * the most recent one is meaningful to the model. Messages that become
 * empty after stripping are dropped entirely to avoid sending empty
 * user messages to the model API.
 */
export const convertToModelMessagesExtended = async (
  messages: ExtendedUIMessage[],
): ReturnType<typeof convertToModelMessages> => {
  let lastUserMsgIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserMsgIdx = i;
      break;
    }
  }

  const filtered =
    lastUserMsgIdx === -1
      ? messages
      : messages.flatMap((msg, i) => {
          if (
            msg.role !== 'user' ||
            i === lastUserMsgIdx ||
            !msg.parts.some((p) => p.type === 'data-continue')
          ) {
            return [msg];
          }
          const parts = msg.parts.filter((p) => p.type !== 'data-continue');
          return parts.length > 0 ? [{ ...msg, parts }] : [];
        });

  return convertToModelMessages<ExtendedUIMessage>(filtered, {
    convertDataPart: convertCustomDataParts,
  });
};

const convertCustomDataParts = (
  part: DataUIPart<CustomUIDataParts>,
): TextPart | FilePart | undefined => {
  if (part.type === 'data-context') {
    // TODO: Add multimodal support

    const metadata = Object.entries(part.data.metadata)
      .map(([k, v]) => `<${k} value="${v.toString()}"/>`)
      .join('');
    const content = part.data.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join(' ');

    return {
      type: 'text',
      text: `<context source-env="${part.data.sourceEnv}"><metadata>${metadata}</metadata><content>${content}</content></context>`,
    };
  } else if (part.type === 'data-history-summary') {
    return {
      type: 'text',
      text: `<summary>${part.data.summary}</summary>`,
    };
  } else if (part.type === 'data-continue') {
    return {
      type: 'text',
      text: 'Continue.',
    };
  } else {
    return undefined;
  }
};
