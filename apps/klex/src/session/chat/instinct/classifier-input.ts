import type { TextPart } from 'ai';

import type {
  DataPartTransformers,
  InstinctHistoryDelta,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  CONTEXT_SUMMARY_KEY,
  createInstinctHistoryView,
  type DataProjector,
  RECORD_SEPARATOR,
} from '@/session/chat/utils/history-view';

import type { InstinctClassifierEntry } from './classifier';
import {
  assembleExternalInput,
  type ExternalInputBlock,
  truncateWithMarker,
} from './external-input';

/** Input limits; mirrors the `instinct` config tunables. */
export interface InstinctClassifierInputLimits {
  readonly recentMessageCount: number;
  readonly deltaMessageCap: number;
  readonly historyCharacterCap: number;
  readonly messageCharacterCap: number;
  readonly contextCharacterCap: number;
}

export interface InstinctClassifierInputArgs {
  readonly entries: readonly InstinctClassifierEntry[];
  readonly history: readonly ExtendedUIMessage[];
  readonly delta: InstinctHistoryDelta;
  readonly dataPartTransformers: DataPartTransformers;
  readonly limits: InstinctClassifierInputLimits;
}

function omittedNewMessagesMarker(count: number): string {
  return `[${count} earlier new messages omitted]`;
}

/**
 * Adapts extension `dataPartTransformer`s into history-view projectors, so
 * the classifier sees extension data the way the main agent does. Only the
 * text parts are kept; files are not useful to a classifier. The summary key
 * is handled by the transcript filter itself.
 */
function createDataProjectors(
  transformers: DataPartTransformers,
  occurrences: Map<string, number>,
): Record<string, DataProjector> {
  const projectors: Record<string, DataProjector> = {};
  for (const [key, transform] of Object.entries(transformers)) {
    if (key === CONTEXT_SUMMARY_KEY) continue;
    projectors[key] = (data) => {
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const value = transform(data, occurrence)
        .filter((part): part is TextPart => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
      return value.length > 0 ? { label: key, value } : null;
    };
  }
  return projectors;
}

/**
 * Picks messages newest-first until the count or character budget runs out.
 * Returns them in history order plus the budget left over.
 */
function takeNewest(
  rendered: readonly string[],
  maxCount: number,
  budget: number,
): { kept: string[]; remaining: number } {
  const kept: string[] = [];
  let remaining = budget;
  for (let i = rendered.length - 1; i >= 0 && kept.length < maxCount; i--) {
    const text = rendered[i]!;
    const separatorCost = kept.length > 0 ? RECORD_SEPARATOR.length : 0;
    const available = remaining - separatorCost;
    if (available <= 0) break;
    if (text.length > available) {
      // Always retain the newest input, even when its per-message cap is
      // larger than the aggregate budget. Do not skip to older messages.
      if (kept.length === 0) {
        kept.unshift(truncateWithMarker(text, available));
        remaining = 0;
      }
      break;
    }
    kept.unshift(text);
    remaining -= text.length + separatorCost;
  }
  return { kept, remaining };
}

/**
 * Builds the classifier's user prompt from the fixed input contract:
 * extension contexts, the last `recentMessageCount` messages that existed
 * before the delta, and the delta itself. New messages get the character
 * budget first; the recent window gets what is left, so it shrinks when the
 * delta is large. Every block is framed as external input.
 */
export function buildInstinctClassifierInput(
  args: InstinctClassifierInputArgs,
): string {
  const { limits, delta } = args;
  const occurrences = new Map<string, number>();
  const view = createInstinctHistoryView({
    messageLimit: limits.messageCharacterCap,
    data: createDataProjectors(args.dataPartTransformers, occurrences),
  });
  const render = (message: ExtendedUIMessage): string | null => {
    const text = view.render([message]).text.trim();
    if (text.length === 0) return null;
    // The renderer bounds records; this bounds the message as a whole.
    return truncateWithMarker(text, limits.messageCharacterCap);
  };
  const addedIds = new Set(delta.added.map(({ id }) => id));
  // Apply the delta count cap before projection. Large initial histories
  // must not invoke transformers for every omitted message.
  const newCandidates = new Set(
    delta.added.slice(-limits.deltaMessageCap).map(({ id }) => id),
  );
  const counts = new Map<string, number>();
  const countParts = (message: ExtendedUIMessage, direction: 1 | -1) => {
    for (const part of message.parts) {
      if (!part.type.startsWith('data-')) continue;
      const key = part.type.slice('data-'.length);
      if (key !== CONTEXT_SUMMARY_KEY && args.dataPartTransformers[key])
        counts.set(key, (counts.get(key) ?? 0) + direction);
    }
  };
  // Only count data parts in the full history; do not project or serialize
  // them. This preserves chronological occurrence indices during a lazy
  // newest-first scan, including messages inserted in the middle.
  for (const message of args.history) countParts(message, 1);
  const renderedNew: string[] = [];
  const renderedEarlier: string[] = [];
  const renderAt = (message: ExtendedUIMessage): string | null => {
    occurrences.clear();
    for (const [key, count] of counts) occurrences.set(key, count);
    return render(message);
  };
  let newCharacters = 0;
  for (let i = args.history.length - 1; i >= 0; i--) {
    const message = args.history[i]!;
    countParts(message, -1);
    if (newCandidates.has(message.id)) {
      if (newCharacters >= limits.historyCharacterCap) continue;
      const text = renderAt(message);
      if (text) {
        renderedNew.push(text);
        newCharacters += text.length + RECORD_SEPARATOR.length;
      }
    } else if (
      !addedIds.has(message.id) &&
      renderedEarlier.length < limits.recentMessageCount
    ) {
      // Empty projections do not consume the recent message count. Keep
      // scanning rather than imposing an arbitrary candidate window.
      const text = renderAt(message);
      if (text) renderedEarlier.push(text);
    }
  }
  renderedNew.reverse();
  renderedEarlier.reverse();
  let newest = takeNewest(
    renderedNew,
    limits.deltaMessageCap,
    limits.historyCharacterCap,
  );
  let omissionCap = 0;
  if (newest.kept.length < delta.added.length) {
    omissionCap = Math.min(
      omittedNewMessagesMarker(delta.added.length).length,
      Math.floor(limits.historyCharacterCap / 3),
    );
    // For tiny budgets, prefer the newest fragment over a marker and its
    // separator. Never reserve away the last character of actual input.
    if (omissionCap + RECORD_SEPARATOR.length >= limits.historyCharacterCap)
      omissionCap = 0;
    if (omissionCap > 0) {
      newest = takeNewest(
        renderedNew,
        limits.deltaMessageCap,
        limits.historyCharacterCap - omissionCap - RECORD_SEPARATOR.length,
      );
    }
  }
  const omittedNewCount = delta.added.length - newest.kept.length;
  const omission =
    omittedNewCount > 0 && omissionCap > 0
      ? truncateWithMarker(
          omittedNewMessagesMarker(omittedNewCount),
          omissionCap,
        )
      : '';
  const newContent = [...(omission ? [omission] : []), ...newest.kept];
  const newText =
    newContent.length > 0
      ? newContent.join(RECORD_SEPARATOR)
      : truncateWithMarker(
          omittedNewCount > 0
            ? omittedNewMessagesMarker(omittedNewCount)
            : '[no new messages]',
          limits.historyCharacterCap,
        );
  const recent = takeNewest(
    renderedEarlier,
    limits.recentMessageCount,
    Math.max(0, limits.historyCharacterCap - newText.length),
  );

  const blocks: ExternalInputBlock[] = [];
  for (const entry of args.entries) {
    const context = entry.request.context?.trim();
    if (!context) continue;
    blocks.push({
      source: `extension:${entry.extensionIdentifier}`,
      kind: 'state',
      content: truncateWithMarker(context, limits.contextCharacterCap),
    });
  }
  if (recent.kept.length > 0) {
    blocks.push({
      source: 'conversation',
      kind: 'recent',
      content: recent.kept.join(RECORD_SEPARATOR),
    });
  }
  blocks.push({
    source: 'conversation',
    kind: 'new',
    content: newText,
  });

  return assembleExternalInput(blocks);
}
