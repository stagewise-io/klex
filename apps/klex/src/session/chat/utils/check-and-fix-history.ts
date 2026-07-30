import { type DynamicToolUIPart, isToolUIPart, type ToolUIPart } from 'ai';

import type { ExtendedUIMessage } from '../message-types';
import type { AgentUITools } from '../tools';

const UNFINISHED_TOOL_ERROR_TEXT =
  'The tool call was not executed for unknown reasons. Try again.';

/** Information about a single repair applied during history fixing. */
export type HistoryRepairInfo = {
  messageId: string;
  partType: string;
  toolCallId: string;
  previousState: string;
  newState: string;
  errorText: string;
};

/** Result of {@link checkAndFixHistory}. */
export type CheckAndFixHistoryResult = {
  repaired: HistoryRepairInfo[];
};

// Validates the correct state of the chat history in order to ensure that a correct call can be made to any models (error unfinished tool calls etc.)
export const checkAndFixHistory = (
  history: ExtendedUIMessage[],
): CheckAndFixHistoryResult => {
  const repaired: HistoryRepairInfo[] = [];

  for (const msg of history) {
    for (const p of msg.parts) {
      // Fix unfinished tool calls
      if (isToolUIPart(p)) {
        if (
          !(
            p.state === 'output-available' ||
            p.state === 'output-denied' ||
            p.state === 'output-error' ||
            p.state === 'approval-responded'
          )
        ) {
          const previousState = p.state;
          (p as DynamicToolUIPart | ToolUIPart<AgentUITools>).state =
            'output-error';
          (p as DynamicToolUIPart | ToolUIPart<AgentUITools>).errorText =
            UNFINISHED_TOOL_ERROR_TEXT;
          repaired.push({
            messageId: msg.id,
            partType: p.type,
            toolCallId: p.toolCallId,
            previousState,
            newState: 'output-error',
            errorText: UNFINISHED_TOOL_ERROR_TEXT,
          });
        }
      }
    }
  }

  return { repaired };
};
