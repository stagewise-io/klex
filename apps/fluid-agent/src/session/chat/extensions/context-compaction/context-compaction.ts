import { randomUUID } from 'node:crypto';

import { context, type Span, trace } from '@opentelemetry/api';
import { getToolName, isToolUIPart, type TextPart } from 'ai';

import type {
  ContextSummaryDataUIPart,
  ExtendedUIMessage,
} from '../../message-types';
import { startChildSpan } from '../../utils/tracing';
import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  HistoryProcessingResult,
  StepCompleteEvent,
} from '../extension-api';
import compactionPrompt from './compaction-prompt.md';

/**
 * Hard upper bound for the compaction threshold in tokens. The dynamic
 * threshold will never exceed this value regardless of model context sizes.
 */
export const MAX_COMPACTION_THRESHOLD = 100_000;

/**
 * Fraction of the model's max context size at which compaction triggers.
 * The threshold is 50% of the smallest context size among all configured
 * chat and compaction models.
 */
export const CONTEXT_SIZE_THRESHOLD_RATIO = 0.5;

/**
 * Fallback threshold used when no models are configured or context sizes
 * cannot be resolved. Also serves as the default in tests that don't
 * provide model context sizes.
 */
export const FALLBACK_COMPACTION_THRESHOLD = 10_000;

/**
 * Minimum number of messages that must exist after a summary before it
 * is applied during history preprocessing. If a newer summary has fewer
 * messages after it than this threshold, it is skipped and an older
 * summary is used instead.
 */
export const MIN_MESSAGES_AFTER_SUMMARY = 2;

/**
 * Minimum number of messages of each role (user, assistant) to retain
 * BEFORE the cutoff summary in the transformed history. This ensures the
 * model always has some real conversation context preceding the summary,
 * rather than the summary appearing as the first message after the system
 * prompt.
 */
export const MIN_MESSAGES_BEFORE_SUMMARY_BY_ROLE = 2;

/**
 * Hysteresis margin applied to the post-compaction baseline. After a
 * successful compaction, the baseline is inflated by this fraction so
 * that small fluctuations around the compacted context size do not
 * immediately re-trigger compaction. Only genuine *new* growth beyond
 * the baseline plus this margin will cause the next compaction.
 */
export const COMPACTION_HYSTERESIS_RATIO = 0.1;

/** Rough estimate of characters per token for baseline estimation. */
const CHARS_PER_TOKEN = 4;

/** Max chars kept from user/assistant text parts. */
const TEXT_TRUNCATE_LIMIT = 500;
/** Max chars kept from tool output. */
const OUTPUT_TRUNCATE_LIMIT = 300;
/** Max chars kept from context parts. */
const CONTEXT_TRUNCATE_LIMIT = 200;
/** Max chars kept from a previous summary. */
const SUMMARY_TRUNCATE_LIMIT = 800;

class ContextCompactionExt implements Extension {
  readonly identifier = 'io.stagewise/context-compaction';
  readonly displayName = 'Context Compaction';

  private accumulatedTokens = 0;
  private compacting = false;
  private cachedThreshold: number | null = null;
  /**
   * Token baseline set after a successful compaction. Represents the
   * estimated token cost of the compacted history (keepBefore + summary).
   * The next compaction only triggers when accumulatedTokens exceeds
   * baseline + threshold, preventing repeated compaction of a context
   * that is already compact but still large.
   */
  private compactionBaseline = 0;

  constructor(private readonly deps: ExtensionDeps) {}

  /**
   * Computes the compaction threshold as the minimum of
   * {@link MAX_COMPACTION_THRESHOLD} and 50% of the smallest context size
   * among all configured chat and compaction models. Falls back to
   * {@link FALLBACK_COMPACTION_THRESHOLD} when no models are configured.
   *
   * The result is cached for the lifetime of the extension instance.
   */
  private getCompactionThreshold(): number {
    if (this.cachedThreshold !== null) return this.cachedThreshold;

    const modelIds = [...this.deps.config.getModelSelection('chat')];

    if (modelIds.length === 0) {
      this.cachedThreshold = FALLBACK_COMPACTION_THRESHOLD;
      return this.cachedThreshold;
    }

    let contextSize = Infinity;
    // We take the lowest context size of all configured models as a base
    // for calculating the relative limit.
    for (const modelId of modelIds) {
      try {
        const ctxSize = this.deps.config.getModelContextSize(modelId);
        if (ctxSize < contextSize) contextSize = ctxSize;
      } catch {
        // Model resolution failed — skip this model.
      }
    }

    if (contextSize === Infinity) {
      this.cachedThreshold = FALLBACK_COMPACTION_THRESHOLD;
      return this.cachedThreshold;
    }

    const dynamicThreshold = Math.floor(
      contextSize * CONTEXT_SIZE_THRESHOLD_RATIO,
    );
    this.cachedThreshold = Math.min(dynamicThreshold, MAX_COMPACTION_THRESHOLD);

    this.deps.logger.info(
      {
        threshold: this.cachedThreshold,
        modelContextSize: contextSize,
        config: {
          maxTokenThreshold: MAX_COMPACTION_THRESHOLD,
          relativeThresholdRatio: CONTEXT_SIZE_THRESHOLD_RATIO,
        },
      },
      'Compaction threshold computed from model context sizes',
    );

    return this.cachedThreshold;
  }
  historyTransformer(history: ExtendedUIMessage[]): HistoryProcessingResult {
    // Collect indices of all summary messages (newest first).
    const summaryIndices: number[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.parts.some((p) => p.type === 'data-context-summary')) {
        summaryIndices.push(i);
      }
    }

    if (summaryIndices.length === 0) return history;

    // Walk summaries from newest to oldest. The first summary that has
    // enough messages after it is the cutoff point.
    let cutoffIndex = -1;
    for (const idx of summaryIndices) {
      const messagesAfter = history.length - idx - 1;
      if (messagesAfter >= MIN_MESSAGES_AFTER_SUMMARY) {
        cutoffIndex = idx;
        break;
      }
    }

    if (cutoffIndex === -1) {
      // No summary has enough messages after it to be a viable cutoff.
      // Still mark as compacted since summaries exist in the history.
      return { history, flags: { hasCompacted: true } };
    }

    // Slice from the cutoff summary. Strip any other summary messages
    // from the result so only the cutoff summary remains — multiple
    // summaries in the context would confuse the model.
    const sliced = history.slice(cutoffIndex);
    const filtered = sliced.filter(
      (msg, i) =>
        i === 0 || // always keep the cutoff summary (first element)
        !msg.parts.some((p) => p.type === 'data-context-summary'),
    );

    // Collect up to MIN_MESSAGES_BEFORE_SUMMARY_BY_ROLE messages of each
    // role from the messages immediately preceding the cutoff summary.
    // This guarantees the model sees some real conversation before the
    // summary, rather than the summary being the first message after the
    // system prompt. Walk backwards from the cutoff to pick the most
    // recent messages of each role.
    const beforeCutoff = history.slice(0, cutoffIndex);
    const minPerRole = MIN_MESSAGES_BEFORE_SUMMARY_BY_ROLE;
    const keepBefore: ExtendedUIMessage[] = [];
    let userCount = 0;
    let assistantCount = 0;

    for (let i = beforeCutoff.length - 1; i >= 0; i--) {
      const msg = beforeCutoff[i]!;
      // Skip other summary messages — they're already represented by the
      // cutoff summary.
      if (msg.parts.some((p) => p.type === 'data-context-summary')) continue;
      if (msg.role === 'user' && userCount < minPerRole) {
        keepBefore.unshift(msg);
        userCount++;
      } else if (msg.role === 'assistant' && assistantCount < minPerRole) {
        keepBefore.unshift(msg);
        assistantCount++;
      }
      if (userCount >= minPerRole && assistantCount >= minPerRole) break;
    }

    return {
      history: [...keepBefore, ...filtered],
      flags: { hasCompacted: true },
    };
  }

  dataPartTransformers = {
    'context-summary': (part: ContextSummaryDataUIPart): TextPart[] => [
      {
        type: 'text',
        text: `<summary>${part.summary}</summary>`,
      },
    ],
  };

  async onStepComplete(event: StepCompleteEvent): Promise<void> {
    if (event.generation === null) return;

    const usage = event.generation.usage;
    const stepTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    this.accumulatedTokens += stepTokens;

    const threshold = this.getCompactionThreshold();
    if (
      this.accumulatedTokens - this.compactionBaseline >= threshold &&
      !this.compacting
    ) {
      this.deps.logger.info(
        {
          accumulatedTokens: this.accumulatedTokens,
          baseline: this.compactionBaseline,
          growthAboveBaseline: this.accumulatedTokens - this.compactionBaseline,
          threshold,
        },
        'Token threshold exceeded — triggering compaction',
      );
      void this.runCompaction();
    }
  }

  private async runCompaction(): Promise<void> {
    this.compacting = true;

    // Capture the token count at the start of this compaction run.
    // New steps may accumulate tokens while compaction is in flight —
    // those should NOT be discarded on success, otherwise a slow
    // compaction followed by nearly a threshold's worth of new steps
    // would delay the next compaction by another full threshold.
    const tokensAtStart = this.accumulatedTokens;

    let span: Span | null = null;
    let success = false;
    try {
      span = startChildSpan('context_compaction', {
        attributes: {
          'compaction.accumulatedTokens': this.accumulatedTokens,
          'compaction.baseline': this.compactionBaseline,
          'compaction.threshold': this.getCompactionThreshold(),
        },
      });

      success = await context.with(
        trace.setSpan(context.active(), span),
        async () => this.runCompactionInner(span!),
      );
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Compaction failed with unexpected error',
      );
      span?.addEvent('compaction.error', { error: String(error) });
    } finally {
      this.compacting = false;
      // On successful compaction, set the baseline to the estimated
      // token cost of the compacted history (plus hysteresis margin).
      // This prevents immediate re-triggering when the compacted
      // context is still large. On skip or failure, keep the counter
      // unchanged so the next step can re-trigger.
      if (success) {
        const compactedTokens = this.estimateCompactedContextTokens();
        this.compactionBaseline = Math.floor(
          compactedTokens * (1 + COMPACTION_HYSTERESIS_RATIO),
        );
        // Preserve tokens that accumulated during compaction, but
        // re-anchor them relative to the new baseline.
        const inflightTokens = this.accumulatedTokens - tokensAtStart;
        this.accumulatedTokens = this.compactionBaseline + inflightTokens;
        span?.setAttribute('compaction.compactedTokens', compactedTokens);
        span?.setAttribute('compaction.newBaseline', this.compactionBaseline);
      }
      span?.end();
    }
  }

  private async runCompactionInner(span: Span): Promise<boolean> {
    let modelIds = this.deps.config.getModelSelection('compaction');

    if (modelIds.length === 0) {
      const chatModelIds = this.deps.config.getModelSelection('chat');
      if (chatModelIds.length === 0) {
        this.deps.logger.warn(
          'No compaction or chat models configured — skipping',
        );
        span.addEvent('compaction.skipped', { reason: 'no-models' });
        return false;
      }
      this.deps.logger.warn(
        'No compaction models configured — falling back to chat models',
      );
      span.addEvent('compaction.fallback_to_chat_models');
      modelIds = chatModelIds;
    }

    span.setAttribute('compaction.modelCount', modelIds.length);
    const history = this.deps.getHistory();
    span.setAttribute('compaction.historyLength', history.length);

    // Slice starting from the last summary (if one exists) so the
    // compaction model has access to the previous summary as context.
    // If there is no summary, compact the entire history.
    const lastSummaryIndex = history.findLastIndex((m) =>
      m.parts.some((p) => p.type === 'data-context-summary'),
    );
    const sliceStart = lastSummaryIndex === -1 ? 0 : lastSummaryIndex;
    const slice = history.slice(sliceStart);
    span.setAttribute('compaction.sliceLength', slice.length);

    // Skip only when there are no messages at all, or when the only
    // message in the slice is a summary with nothing new after it.
    const hasNewMessages =
      slice.length > 1 || (slice.length === 1 && lastSummaryIndex === -1);

    if (!hasNewMessages) {
      this.deps.logger.debug(
        { totalHistory: history.length, sliceLength: slice.length },
        'No new messages to compact — skipping',
      );
      span.addEvent('compaction.skipped', { reason: 'no-messages' });
      return false;
    }

    const transcript = transformHistoryForCompaction(slice);
    span.setAttribute('compaction.transcriptLength', transcript.length);

    if (transcript.trim().length === 0) {
      this.deps.logger.debug('Empty transcript — skipping compaction');
      span.addEvent('compaction.skipped', { reason: 'empty-transcript' });
      return false;
    }

    span.addEvent('compaction.transcript_ready', {
      'compaction.transcriptLength': transcript.length,
      'compaction.sliceLength': slice.length,
    });

    // Capture the ID of the last message in the compaction slice.
    // The summary will be inserted right after it so it stays in the
    // correct position even if new messages have been appended to the
    // history while compaction was running.
    const lastSliceMessageId = slice[slice.length - 1]!.id;
    span.setAttribute('compaction.lastSliceMessageId', lastSliceMessageId);

    const result = await this.deps.generateText({
      modelIds,
      system: compactionPrompt,
      prompt: transcript,
    });

    if (!result.success) {
      // All compaction models failed — try chat models as a last resort.
      const chatModelIds = this.deps.config.getModelSelection('chat');
      if (chatModelIds.length > 0) {
        this.deps.logger.warn(
          'All compaction models failed — falling back to chat models',
        );
        span.addEvent('compaction.fallback_to_chat_models_after_failure');
        const fallbackResult = await this.deps.generateText({
          modelIds: chatModelIds,
          system: compactionPrompt,
          prompt: transcript,
        });

        if (!fallbackResult.success) {
          span.addEvent('compaction.failed', {
            reason: 'all-models-failed-including-chat',
            failureReason: fallbackResult.failureReason,
            failureDetails: fallbackResult.failureDetails ?? '',
          });
          return false;
        }

        return this.injectSummary(
          fallbackResult.text,
          lastSliceMessageId,
          span,
        );
      }

      span.addEvent('compaction.failed', {
        reason: 'all-models-failed',
        failureReason: result.failureReason,
        failureDetails: result.failureDetails ?? '',
      });
      return false;
    }

    return this.injectSummary(result.text, lastSliceMessageId, span);
  }

  /**
   * Inserts the summary message into the chat history after the anchor
   * message and records telemetry.
   */
  private async injectSummary(
    summary: string,
    anchorId: string,
    span: Span,
  ): Promise<boolean> {
    const summaryMessage: ExtendedUIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [
        {
          type: 'data-context-summary',
          data: { summary },
        },
      ],
    };

    // Insert the summary directly after the last message that was part
    // of the compaction slice — not at the end of history, which may
    // have grown since compaction was triggered.
    const inserted = this.deps.insertMessageAfter(anchorId, summaryMessage);

    if (!inserted) {
      this.deps.logger.warn(
        { anchorId },
        'Last compaction-slice message no longer exists — summary dropped',
      );
      span.addEvent('compaction.insert_failed', {
        reason: 'anchor-message-gone',
      });
      return false;
    }

    span.setAttribute('compaction.summaryLength', summary.length);
    span.addEvent('compaction.summary_injected');
    this.deps.logger.info(
      { summaryLength: summary.length },
      'History compacted and summary injected after last slice message',
    );
    return true;
  }

  /**
   * Estimates the token cost of the compacted history that
   * {@link historyTransformer} will produce: the `keepBefore` messages
   * plus the summary message. Uses the same XML transcript
   * representation as the compaction prompt and a rough chars-per-token
   * heuristic. This is intentionally approximate — it only needs to be
   * good enough to prevent repeated compaction of an already-compact
   * context.
   */
  private estimateCompactedContextTokens(): number {
    const history = this.deps.getHistory();

    // Find the newest summary — this is what historyTransformer will use
    // as the cutoff.
    const lastSummaryIndex = history.findIndex((m) =>
      m.parts.some((p) => p.type === 'data-context-summary'),
    );
    if (lastSummaryIndex === -1) return 0;

    // Replicate the keepBefore logic from historyTransformer:
    // up to MIN_MESSAGES_BEFORE_SUMMARY_BY_ROLE messages of each role
    // immediately preceding the cutoff summary.
    const beforeCutoff = history.slice(0, lastSummaryIndex);
    const minPerRole = MIN_MESSAGES_BEFORE_SUMMARY_BY_ROLE;
    const keepBefore: ExtendedUIMessage[] = [];
    let userCount = 0;
    let assistantCount = 0;

    for (let i = beforeCutoff.length - 1; i >= 0; i--) {
      const msg = beforeCutoff[i]!;
      if (msg.parts.some((p) => p.type === 'data-context-summary')) continue;
      if (msg.role === 'user' && userCount < minPerRole) {
        keepBefore.unshift(msg);
        userCount++;
      } else if (msg.role === 'assistant' && assistantCount < minPerRole) {
        keepBefore.unshift(msg);
        assistantCount++;
      }
      if (userCount >= minPerRole && assistantCount >= minPerRole) break;
    }

    const summaryMessage = history[lastSummaryIndex]!;
    const compactedHistory = [...keepBefore, summaryMessage];
    const transcript = transformHistoryForCompaction(compactedHistory);

    return Math.ceil(transcript.length / CHARS_PER_TOKEN);
  }
}

/**
 * Truncates a string to `limit` chars, appending `…` if truncated.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * Compacts a JSON-serializable value into a single-line string with no
 * whitespace between tokens.
 */
function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Extracts a text representation from a tool output value.
 * Tool outputs in the AI SDK can be strings, objects, or arrays.
 */
function toolOutputToString(output: unknown): string {
  if (typeof output === 'string') return output;
  return compactJson(output);
}

/**
 * Escapes XML special characters in a string so it can be safely
 * embedded inside XML tag content or attribute values.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Renders a single message part as a compact XML fragment.
 * Returns an empty string for parts that should be skipped.
 */
function partToXml(part: ExtendedUIMessage['parts'][number]): string {
  if (part.type === 'text') {
    return `<text>${escapeXml(truncate(part.text, TEXT_TRUNCATE_LIMIT))}</text>`;
  }

  if (part.type === 'data-context-summary') {
    return `<summary>${escapeXml(truncate(part.data.summary, SUMMARY_TRUNCATE_LIMIT))}</summary>`;
  }

  if (part.type === 'data-context') {
    const contentTags = part.data.content
      .map((c) => {
        if (c.type === 'text') {
          return `<text>${escapeXml(truncate(c.text, CONTEXT_TRUNCATE_LIMIT))}</text>`;
        }
        // Non-text content (image/video/audio) — compact placeholder
        return `<${c.type} />`;
      })
      .join('');
    return `<ctx env="${escapeXml(part.data.sourceEnv)}">${contentTags}</ctx>`;
  }

  if (isToolUIPart(part)) {
    const toolName = getToolName(part);

    if (part.state === 'output-available' && part.output !== undefined) {
      const output = toolOutputToString(part.output);
      return `<tool name="${escapeXml(toolName)}"><output>${escapeXml(truncate(output, OUTPUT_TRUNCATE_LIMIT))}</output></tool>`;
    }
    if (part.state === 'output-error') {
      const errText = part.errorText ?? 'unknown error';
      return `<tool name="${escapeXml(toolName)}"><error>${escapeXml(truncate(errText, OUTPUT_TRUNCATE_LIMIT))}</error></tool>`;
    }
    if (part.state === 'output-denied') {
      return `<tool name="${escapeXml(toolName)}"><denied /></tool>`;
    }
    // Tool call with no output yet — just the name
    return `<tool name="${escapeXml(toolName)}" />`;
  }

  // Skip: data-continue and any unknown parts
  return '';
}

/**
 * Transforms a slice of chat history into a dense XML transcript
 * suitable for the compaction model. Each message is wrapped in a
 * `<msg role="user|assistant">` tag containing compact child tags
 * for each part (`<text>`, `<tool>`, `<ctx>`, `<summary>`).
 */
function transformHistoryForCompaction(messages: ExtendedUIMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const inner = msg.parts
      .map((p) => partToXml(p))
      .filter((s) => s.length > 0)
      .join('');

    if (inner.length > 0) {
      lines.push(`<msg role="${msg.role}">${inner}</msg>`);
    }
  }

  return lines.join('\n');
}

export const createContextCompactionExt: ExtensionFactory = {
  identifier: 'io.stagewise/context-compaction',
  displayName: 'Context Compaction',
  create: (deps) => new ContextCompactionExt(deps),
};
