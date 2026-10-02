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
  const earlier = args.history.filter(({ id }) => !addedIds.has(id));
  const recentCandidates =
    limits.recentMessageCount === 0
      ? []
      : earlier.slice(-Math.max(limits.recentMessageCount * 4, 20));
  const selectedIds = new Set([
    ...addedIds,
    ...recentCandidates.map(({ id }) => id),
  ]);
  const rendered = new Map<string, string | null>();
  // Project selected messages once in history order. Count skipped data
  // parts too, so indices match a full conversion without invoking old
  // transformers merely to recover their occurrence numbers.
  for (const message of args.history) {
    if (selectedIds.has(message.id)) {
      rendered.set(message.id, render(message));
    } else {
      for (const part of message.parts) {
        if (!part.type.startsWith('data-')) continue;
        const key = part.type.slice('data-'.length);
        if (key !== CONTEXT_SUMMARY_KEY && args.dataPartTransformers[key])
          occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      }
    }
  }
  const renderAll = (messages: readonly ExtendedUIMessage[]): string[] =>
    messages
      .map(({ id }) => rendered.get(id))
      .filter((text): text is string => typeof text === 'string');

  const renderedNew = renderAll(delta.added);
  let newest = takeNewest(
    renderedNew,
    limits.deltaMessageCap,
    limits.historyCharacterCap,
  );
  // Reserve bounded space for the omission record too. Keep most of even a
  // tiny budget for the newest actual input, rather than only metadata.
  let omissionCap = 0;
  if (newest.kept.length < renderedNew.length) {
    omissionCap = Math.min(
      omittedNewMessagesMarker(renderedNew.length).length,
      Math.floor(limits.historyCharacterCap / 3),
    );
    newest = takeNewest(
      renderedNew,
      limits.deltaMessageCap,
      Math.max(
        0,
        limits.historyCharacterCap - omissionCap - RECORD_SEPARATOR.length,
      ),
    );
  }
  const omittedNewCount = renderedNew.length - newest.kept.length;
  const omission =
    omittedNewCount > 0
      ? truncateWithMarker(
          omittedNewMessagesMarker(omittedNewCount),
          omissionCap,
        )
      : '';

  // Render only the tail that can fit; empty messages do not count.
  const renderedEarlier = renderAll(recentCandidates);
  const recent = takeNewest(
    renderedEarlier,
    limits.recentMessageCount,
    Math.max(
      0,
      newest.remaining - (newest.kept.length > 0 ? RECORD_SEPARATOR.length : 0),
    ),
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
  const newContent = [...(omission ? [omission] : []), ...newest.kept];
  blocks.push({
    source: 'conversation',
    kind: 'new',
    content:
      newContent.length > 0
        ? newContent.join(RECORD_SEPARATOR)
        : '[no new messages]',
  });

  return assembleExternalInput(blocks);
}
