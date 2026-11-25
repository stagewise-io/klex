import type { DataPartTransformers } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  createInstinctHistoryView,
  RECORD_SEPARATOR,
  renderFittedMessage,
} from '@/session/chat/utils/history-view';

import type { InstinctClassifierEntry } from './classifier';
import { frameInstinctEvidence, truncateWithMarker } from './external-input';

/** Size limits; the history window itself is always five messages. */
export interface InstinctClassifierInputLimits {
  readonly historyCharacterCap: number;
  readonly messageCharacterCap: number;
  readonly contextCharacterCap: number;
}

export interface InstinctClassifierInputArgs {
  projectContext?: (
    context: import('@/session/inbox').ContextDataUIPart,
  ) => import('@/session/inbox').ContextDataUIPart;
  readonly entries: readonly InstinctClassifierEntry[];
  readonly history: readonly ExtendedUIMessage[];
  readonly dataPartTransformers: DataPartTransformers;
  readonly limits: InstinctClassifierInputLimits;
}

const HISTORY_MESSAGE_COUNT = 5;

/** Keep a chronological suffix, retaining the newest fragment for tiny budgets. */
function fitHistory(rendered: readonly string[], budget: number): string {
  const kept: string[] = [];
  let remaining = budget;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const text = rendered[i];
    if (!text) continue;
    const available =
      remaining - (kept.length > 0 ? RECORD_SEPARATOR.length : 0);
    if (available <= 0) break;
    if (text.length > available) {
      if (kept.length === 0) kept.unshift(truncateWithMarker(text, available));
      break;
    }
    kept.unshift(text);
    remaining = available - text.length;
  }
  return kept.join(RECORD_SEPARATOR);
}

/**
 * One chronological window of the last five main-agent messages. Delta
 * membership does not affect selection or add freshness annotations.
 * Extension states stay separate; size limits favor the newest activity.
 */
export function buildInstinctClassifierInput(
  args: InstinctClassifierInputArgs,
): string {
  const { limits } = args;
  const windowStart = Math.max(0, args.history.length - HISTORY_MESSAGE_COUNT);
  const view = createInstinctHistoryView({
    transformers: args.dataPartTransformers,
    projectContext: args.projectContext,
  });
  const rendered = view
    .fit(args.history, {
      kind: 'after-cursor',
      cursor: args.history[windowStart - 1]?.id ?? null,
    })
    .messages.map((message) =>
      truncateWithMarker(
        renderFittedMessage(message).text,
        limits.messageCharacterCap,
      ),
    );
  const activity = fitHistory(rendered, limits.historyCharacterCap);
  const states: { extension: string; content: string }[] = [];
  for (const [index, entry] of args.entries.entries()) {
    const context = entry.request.context?.trim();
    if (!context) continue;
    states.push({
      extension: `e${index}`,
      content: truncateWithMarker(context, limits.contextCharacterCap),
    });
  }
  return frameInstinctEvidence(activity, states);
}
