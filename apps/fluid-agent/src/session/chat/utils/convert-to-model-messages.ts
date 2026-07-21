import {
  convertToModelMessages,
  type DataUIPart,
  type FilePart,
  type TextPart,
} from 'ai';
import type { CustomUIDataParts, ExtendedUIMessage } from '@/session/types';

/**
 * Implements an extended "convertToModelMessages" function that converts a list of messages into the format expected by the model.
 *
 * @note This function also adds the system prompt for the agent
 */
export const convertToModelMessagesExtended = async (
  messages: ExtendedUIMessage[],
): ReturnType<typeof convertToModelMessages> => {
  // We only return the messages that have been sent after the last message that contains a history-summary part
  // TODO

  // Convert the messages using the original function
  const modelMessages = await convertToModelMessages<ExtendedUIMessage>(
    messages,
    {
      convertDataPart: convertCustomDataParts,
    },
  );

  // Add any additional processing or transformations here if needed

  return modelMessages;
};

const convertCustomDataParts = (
  part: DataUIPart<CustomUIDataParts>,
): TextPart | FilePart | undefined => {
  if (part.type === 'data-context') {
    // TODO: Add multimodal support

    const metadata = Object.entries(part.data.metadata).map(
      ([k, v]) => `<${k} value="${v.toString()}"/>`,
    );
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
  } else {
    return undefined;
  }
};
