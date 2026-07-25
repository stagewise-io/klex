import { isToolUIPart } from 'ai';

import type { ExtendedUIMessage } from '@/session/types';

/**
 * Repairs a partial message that was sent due to stop token or any other failure reason in-place.
 * @param message The message that should be repaired in place
 * @returns true, if the message should be kept. false, if it's not salvagable and should just be thrown away
 */
export const repairPartialMessage = (message: ExtendedUIMessage): boolean => {
  const hasFullyStreamedToolCall = message.parts.some(
    (p) => isToolUIPart(p) && p.state !== 'input-streaming',
  );
  const hasNonReasoningContent = message.parts.some(
    (p) => p.type !== 'reasoning' && p.type !== 'reasoning-file',
  );

  // If the message contains at least one fully streamed tool-call, we can NOT discard this message
  if (hasFullyStreamedToolCall) {
    removeBrokenParts(message);
    return true;
  }

  if (hasNonReasoningContent) {
    removeBrokenParts(message);
    return true;
  }

  // Only reasoning/reasoning-file parts remain — nothing useful to salvage.
  return false;
};

const removeBrokenParts = (message: ExtendedUIMessage) => {
  // Remove everything that is a potential failure mode:
  // 1. Trailing reasoning and reasoning-file parts at the end of the message
  // 2. Tool calls that are still streaming (state === 'input-streaming')
  // Everything else is kept.

  // Strip trailing reasoning / reasoning-file parts from the end
  let endIdx = message.parts.length;
  while (
    endIdx > 0 &&
    (message.parts[endIdx - 1]?.type === 'reasoning' ||
      message.parts[endIdx - 1]?.type === 'reasoning-file')
  ) {
    endIdx--;
  }

  // From the remaining parts, remove streaming tool calls, keep the rest
  message.parts = message.parts
    .slice(0, endIdx)
    .filter((p) => !isToolUIPart(p) || p.state !== 'input-streaming');
};
