import { LINES_TRUNCATION_MARKER, RECORD_SEPARATOR } from './lines';
import type {
  HistoryBudget,
  HistorySegment,
  RenderedHistory,
  RenderedMessage,
} from './types';

/** A message in scope after rendering; `rendered` is null when empty. */
export interface BudgetInput {
  id: string;
  hasSummary: boolean;
  rendered: RenderedMessage | null;
}

interface Selected extends RenderedMessage {
  id: string;
  hasSummary: boolean;
}

export function applyBudget(
  messages: readonly BudgetInput[],
  startCursor: string | null,
  budget: HistoryBudget | undefined,
): RenderedHistory {
  const lastCursor = messages.at(-1)?.id ?? startCursor;
  const nonEmpty = toSelected(messages);
  if (!budget) {
    return {
      text: nonEmpty.map(({ text }) => text).join(RECORD_SEPARATOR),
      segments: joinSegments(nonEmpty),
      cursor: lastCursor,
      truncated: false,
    };
  }
  if (budget.keep === 'newest') {
    const { text, truncated } = keepNewest(nonEmpty, budget);
    return {
      text,
      segments: text ? [{ type: 'text', text }] : [],
      cursor: lastCursor,
      truncated,
    };
  }
  return keepOldest(messages, startCursor, budget);
}

function toSelected(messages: readonly BudgetInput[]): Selected[] {
  const selected: Selected[] = [];
  for (const message of messages) {
    if (!message.rendered) continue;
    selected.push({
      id: message.id,
      hasSummary: message.hasSummary,
      text: message.rendered.text,
      segments: message.rendered.segments,
    });
  }
  return selected;
}

function joinSegments(messages: readonly Selected[]): HistorySegment[] {
  return messages.flatMap((message) => message.segments);
}

/**
 * Keeps the latest summary message plus the newest ordinary messages after
 * it. Characters are filled summary first, then newest to oldest.
 */
function keepNewest(
  messages: readonly Selected[],
  budget: Extract<HistoryBudget, { keep: 'newest' }>,
): { text: string; truncated: boolean } {
  const marker = LINES_TRUNCATION_MARKER;
  const separator = RECORD_SEPARATOR;
  const latestSummaryPosition = messages.findLastIndex(
    ({ hasSummary }) => hasSummary,
  );
  const latestSummary = messages[latestSummaryPosition];
  const recentCandidates = messages.filter(
    ({ hasSummary }, position) =>
      !hasSummary && position > latestSummaryPosition,
  );
  const rawRecentLimit = budget.recentMessageLimit;
  const recentLimit =
    rawRecentLimit === undefined
      ? recentCandidates.length
      : Number.isFinite(rawRecentLimit) && rawRecentLimit > 0
        ? Math.floor(rawRecentLimit)
        : 0;
  const recentMessages =
    recentLimit === 0 ? [] : recentCandidates.slice(-recentLimit);
  const selectedMessages = [
    ...(latestSummary ? [latestSummary] : []),
    ...recentMessages,
  ];
  const selectionTruncated = selectedMessages.length < messages.length;
  const complete = selectedMessages.map(({ text }) => text).join(separator);
  const completeWithMarker = selectionTruncated
    ? [marker, complete].filter(Boolean).join(separator)
    : complete;
  const limit = budget.maxCharacters;
  if (limit === undefined || completeWithMarker.length <= limit) {
    return { text: completeWithMarker, truncated: selectionTruncated };
  }

  if (limit <= marker.length) {
    return { text: marker.slice(0, Math.max(0, limit)), truncated: true };
  }

  const selected: string[] = [];
  let used = marker.length;
  const summary = latestSummary?.text;
  if (summary && used + summary.length + separator.length <= limit) {
    selected.push(summary);
    used += summary.length + separator.length;
  }

  const recent: string[] = [];
  for (let index = recentMessages.length - 1; index >= 0; index--) {
    const message = recentMessages[index];
    if (!message) continue;
    if (used + message.text.length + separator.length > limit) break;
    recent.unshift(message.text);
    used += message.text.length + separator.length;
  }

  return {
    text: [marker, ...selected, ...recent].filter(Boolean).join(separator),
    truncated: true,
  };
}

/**
 * Consumes messages in order until the next one would exceed the budget.
 * Empty messages advance the cursor without using budget.
 */
function keepOldest(
  messages: readonly BudgetInput[],
  startCursor: string | null,
  budget: Extract<HistoryBudget, { keep: 'oldest' }>,
): RenderedHistory {
  const separator = RECORD_SEPARATOR;
  const included: Selected[] = [];
  let cursor = startCursor;
  let total = 0;
  let truncated = false;

  for (const message of messages) {
    if (!message.rendered) {
      cursor = message.id;
      continue;
    }
    const { text, segments } = message.rendered;
    const added = text.length + (included.length > 0 ? separator.length : 0);
    if (total + added > budget.maxCharacters) {
      truncated = true;
      break;
    }
    included.push({
      id: message.id,
      hasSummary: message.hasSummary,
      text,
      segments,
    });
    total += added;
    cursor = message.id;
  }

  return {
    text: included.map((message) => message.text).join(separator),
    segments: joinSegments(included),
    cursor,
    truncated,
  };
}
