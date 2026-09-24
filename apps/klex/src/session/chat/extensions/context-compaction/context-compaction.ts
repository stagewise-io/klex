import { randomUUID } from 'node:crypto';

import { context, type Span, trace } from '@opentelemetry/api';

import type { ModelPurpose } from '@/config';
import { escapeXml } from '@/session/chat/utils/escape-xml';
import {
  CONTEXT_SUMMARY_KEY,
  createTranscriptHistoryView,
  LINES_FORMAT_PROMPT,
} from '@/session/chat/utils/history-view';

import type { ExtendedUIMessage } from '../../message-types';
import { startChildSpan } from '../../utils/tracing';
import {
  createDataPart,
  type DataPartTransformers,
  dataPartTransformer,
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  type HistoryProcessingResult,
  isDataPartOf,
  type StepCompleteEvent,
} from '../extension-api';
import compactionPrompt from './compaction-prompt.md';

const COMPACTION_TRANSCRIPT_VIEW = createTranscriptHistoryView();
const COMPACTION_SYSTEM_PROMPT = `${compactionPrompt}\n\n${LINES_FORMAT_PROMPT}`;

/**
 * Custom data part that stores a history summary of the chat session.
 * This type is local to the extension — it is NOT registered in the
 * central `CustomUIDataParts` map.
 */
export type ContextSummaryDataUIPart = {
  summary: string;
};

/**
 * Hard upper bound for the compaction threshold in tokens. The dynamic
 * threshold will never exceed this value regardless of model context sizes.
 */
export const MAX_COMPACTION_THRESHOLD = 100_000;

/**
 * Fraction of the model's max context size at which compaction triggers.
 * The threshold is 50% of the smallest context size among the selected
 * threshold-purpose models.
 */
export const CONTEXT_SIZE_THRESHOLD_RATIO = 0.5;

/**
 * Fallback threshold used when no models are configured or context sizes
 * cannot be resolved. Also serves as the default in tests that don't
 * provide model context sizes.
 */
export const FALLBACK_COMPACTION_THRESHOLD = 10_000;

/**
 * Minimum number of user messages that must exist after a summary before
 * it is applied during history preprocessing. If a newer summary has fewer
 * user messages after it than this threshold, it is skipped and an older
 * summary is used instead.
 */
export const MIN_USER_MESSAGES_AFTER_SUMMARY = 2;

/**
 * Minimum number of assistant messages that must exist after a summary
 * before it is applied during history preprocessing.
 */
export const MIN_ASSISTANT_MESSAGES_AFTER_SUMMARY = 1;

/**
 * Hysteresis margin for post-compaction re-triggering. After a
 * successful compaction, the inputTokens of the first subsequent
 * step become the post-compaction baseline. The next compaction
 * only triggers when the latest step's inputTokens exceed this
 * baseline by at least this fraction (0.1 = 10% growth), preventing
 * repeated compaction of a context that is already compact but
 * still large. Both the absolute threshold AND this hysteresis
 * check must be satisfied to trigger.
 */
export const COMPACTION_HYSTERESIS_RATIO = 0.1;

class ContextCompactionExt implements Extension {
  /**
   * inputTokens from the most recent step — used as a proxy for
   * current context size. Unlike a cumulative sum (which grows
   * quadratically because each step's inputTokens includes the
   * full history), this reflects the actual context consumption at
   * the latest point in time.
   */
  private lastStepInputTokens = 0;

  /**
   * After a successful compaction, the inputTokens of the first
   * subsequent step are captured as the post-compaction baseline.
   * The next compaction requires the latest step's inputTokens to
   * exceed this baseline by at least {@link COMPACTION_HYSTERESIS_RATIO},
   * preventing immediate re-compaction of an already-compact context.
   * Set to 0 before the first compaction or after a failed/skipped
   * compaction (no baseline → only the absolute threshold applies).
   */
  private postCompactionBaseline = 0;

  /**
   * Set to true after a successful compaction. The next
   * {@link onStepComplete} call captures inputTokens as the new
   * postCompactionBaseline and clears this flag. This ensures the
   * baseline reflects the actual compacted context size as measured
   * by the model, not a pre-compaction estimate.
   */
  private awaitingPostCompactionBaseline = false;

  private compacting = false;
  private cachedThreshold: number | null = null;
  private latestSummary: string | null = null;

  /**
   * Per-step flag set by `historyTransformer` when the summary was
   * actually applied (slicing occurred). Reset to `false` in
   * `onStepStart` at the beginning of each step. Checked by
   * `onStepComplete` before capturing the post-compaction baseline —
   * if the summary wasn't applied, the baseline capture is deferred
   * to a future step where the transformer does apply it.
   */
  private summaryAppliedThisStep = false;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly thresholdModelPurpose: ModelPurpose = 'chat',
  ) {}

  onStepStart(): void {
    this.summaryAppliedThisStep = false;
  }

  /**
   * Computes the compaction threshold as the minimum of
   * {@link MAX_COMPACTION_THRESHOLD} and 50% of the smallest context size
   * among all configured threshold-purpose models. Falls back to
   * {@link FALLBACK_COMPACTION_THRESHOLD} when no models are configured.
   *
   * The result is cached for the lifetime of the extension instance.
   */
  private getCompactionThreshold(): number {
    if (this.cachedThreshold !== null) return this.cachedThreshold;

    const modelIds = [
      ...this.deps.config.getModelSelection(this.thresholdModelPurpose),
    ];

    if (modelIds.length === 0) {
      this.cachedThreshold = FALLBACK_COMPACTION_THRESHOLD;
      return this.cachedThreshold;
    }

    let contextSize = Infinity;
    // We take the lowest context size of all configured models as a base
    // for calculating the relative limit.
    for (const modelId of modelIds) {
      try {
        const ctxSize =
          this.deps.modelResolver.resolveModelInfo(modelId).contextSize;
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
      if (history[i]?.parts.some((p) => isDataPartOf(CONTEXT_SUMMARY_KEY, p))) {
        summaryIndices.push(i);
      }
    }

    if (summaryIndices.length === 0) return history;

    // Walk summaries from newest to oldest. The first summary that
    // has enough user and assistant messages after it is the cutoff
    // point. No messages before the cutoff summary are retained —
    // the summary replaces all preceding history.
    let cutoffIndex = -1;
    for (const idx of summaryIndices) {
      const { userCount, assistantCount } = countMessagesByRoleAfter(
        history,
        idx,
      );
      if (
        userCount >= MIN_USER_MESSAGES_AFTER_SUMMARY &&
        assistantCount >= MIN_ASSISTANT_MESSAGES_AFTER_SUMMARY
      ) {
        cutoffIndex = idx;
        break;
      }
    }

    if (cutoffIndex === -1) {
      // No summary has enough messages after it to be a viable cutoff.
      // Still mark as compacted since summaries exist in the history,
      // but the summary was NOT applied — don't set the flag.
      return { history, flags: { hasCompacted: true } };
    }

    // The summary is being applied — record this so `onStepComplete`
    // knows the compacted history was actually used by the model.
    this.summaryAppliedThisStep = true;

    // Slice from the cutoff summary. Strip any other summary messages
    // from the result so only the cutoff summary remains — multiple
    // summaries in the context would confuse the model. No messages
    // before the summary are retained.
    const sliced = history.slice(cutoffIndex);
    const filtered = sliced.filter(
      (msg, i) =>
        i === 0 || // always keep the cutoff summary (first element)
        !msg.parts.some((p) => isDataPartOf(CONTEXT_SUMMARY_KEY, p)),
    );

    return {
      history: filtered,
      flags: { hasCompacted: true },
    };
  }

  introspect(): Record<string, unknown> {
    return {
      status: this.compacting ? 'compacting' : 'idle',
      latestSummary: this.latestSummary,
    };
  }

  dataPartTransformers: DataPartTransformers = {
    [CONTEXT_SUMMARY_KEY]: dataPartTransformer<ContextSummaryDataUIPart>(
      (data) => [
        {
          type: 'text',
          text: `<summary>${escapeXml(data.summary)}</summary>`,
        },
      ],
    ),
  };

  async onStepComplete(event: StepCompleteEvent): Promise<void> {
    if (event.generation === null) return;

    const inputTokens = event.generation.usage.inputTokens ?? 0;
    this.lastStepInputTokens = inputTokens;

    // After a successful compaction, the first subsequent step where
    // the summary was ACTUALLY applied by the history transformer
    // establishes the post-compaction baseline. This is the actual
    // measured context size after compaction — more accurate than
    // any estimate. We skip the trigger check for this step because
    // it IS the baseline: there is nothing to compare against.
    //
    // If the summary was not applied (not enough messages after it
    // yet), we keep awaiting — the baseline is deferred to a future
    // step where the transformer does apply the summary.
    if (this.awaitingPostCompactionBaseline) {
      if (!this.summaryAppliedThisStep) {
        this.deps.logger.debug(
          { inputTokens },
          'Awaiting baseline but summary was not applied this step — deferring',
        );
        return;
      }
      this.postCompactionBaseline = inputTokens;
      this.awaitingPostCompactionBaseline = false;
      this.deps.logger.info(
        { postCompactionBaseline: this.postCompactionBaseline },
        'Post-compaction baseline established from first step where summary was applied',
      );
      return;
    }

    // Trigger compaction only when BOTH conditions are met:
    //   1. inputTokens >= absolute threshold (50% of context window)
    //   2. inputTokens >= baseline * (1 + hysteresis) — at least 10%
    //      growth above the post-compaction baseline (if a baseline
    //      exists; before the first compaction, only condition 1
    //      applies since baseline is 0 → hysteresis threshold is 0).
    const threshold = this.getCompactionThreshold();
    const hysteresisThreshold =
      this.postCompactionBaseline > 0
        ? this.postCompactionBaseline * (1 + COMPACTION_HYSTERESIS_RATIO)
        : 0;

    if (
      !this.compacting &&
      this.lastStepInputTokens >= threshold &&
      this.lastStepInputTokens >= hysteresisThreshold
    ) {
      this.deps.logger.info(
        {
          lastStepInputTokens: this.lastStepInputTokens,
          postCompactionBaseline: this.postCompactionBaseline,
          threshold,
          hysteresisThreshold,
        },
        'Context size threshold exceeded — triggering compaction',
      );
      void this.runCompaction();
    }
  }

  private async runCompaction(): Promise<void> {
    this.compacting = true;

    let span: Span | null = null;
    let success = false;
    try {
      const childSpan = startChildSpan('context_compaction', {
        attributes: {
          'compaction.lastStepInputTokens': this.lastStepInputTokens,
          'compaction.postCompactionBaseline': this.postCompactionBaseline,
          'compaction.threshold': this.getCompactionThreshold(),
        },
      });
      span = childSpan;

      success = await context.with(
        trace.setSpan(context.active(), childSpan),
        async () => this.runCompactionInner(childSpan),
      );
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Compaction failed with unexpected error',
      );
      span?.addEvent('compaction.error', { error: String(error) });
    } finally {
      this.compacting = false;
      if (success) {
        // Mark that the next step should establish the post-compaction
        // baseline. We don't set the baseline here because the actual
        // context size after compaction is only known once the model
        // processes the compacted history — measured by the next
        // step's inputTokens.
        this.awaitingPostCompactionBaseline = true;
        this.postCompactionBaseline = 0;
        span?.setAttribute('compaction.awaitingBaseline', true);
      } else {
        // On failure or skip, reset the baseline so the next step
        // can re-trigger without hysteresis (only the absolute
        // threshold applies). If compaction didn't happen, there's
        // no compacted context to use as a reference point.
        this.postCompactionBaseline = 0;
        this.awaitingPostCompactionBaseline = false;
      }
      span?.end();
    }
  }

  private async runCompactionInner(span: Span): Promise<boolean> {
    let modelIds = this.deps.config.getModelSelection('compaction');

    // Tracks whether modelIds was already set to chat models because
    // no compaction models were configured. When true, the post-failure
    // chat-model fallback is skipped — retrying with the same models
    // that just failed would be a wasted API call.
    let usedChatFallback = false;

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
      usedChatFallback = true;
    }

    span.setAttribute('compaction.modelCount', modelIds.length);
    const history = this.deps.getHistory();
    span.setAttribute('compaction.historyLength', history.length);

    // Slice starting from the last summary (if one exists) so the
    // compaction model has access to the previous summary as context.
    // If there is no summary, compact the entire history.
    const lastSummaryIndex = history.findLastIndex((m) =>
      m.parts.some((p) => isDataPartOf(CONTEXT_SUMMARY_KEY, p)),
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

    const transcript = COMPACTION_TRANSCRIPT_VIEW.render(slice).text;
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
    const lastSliceMessage = slice.at(-1);
    if (!lastSliceMessage) {
      throw new Error('Cannot record an empty compaction slice');
    }
    const lastSliceMessageId = lastSliceMessage.id;
    span.setAttribute('compaction.lastSliceMessageId', lastSliceMessageId);

    const result = await this.deps.generateText({
      modelIds,
      system: COMPACTION_SYSTEM_PROMPT,
      prompt: transcript,
    });

    if (!result.success) {
      if (result.failureReason === 'content-filter') {
        this.deps.logger.warn(
          { failureDetails: result.failureDetails },
          'Compaction models returned content-filter — refusing to inject refusal text as summary',
        );
        span.addEvent('compaction.content_filter', {
          failureDetails: result.failureDetails ?? '',
        });
      }

      // All compaction models failed (or content-filtered) — try
      // chat models as a last resort, but only if we haven't already
      // fallen back to chat models above (no compaction models
      // configured). Retrying with the same chat models that just
      // failed would be a wasted call.
      if (!usedChatFallback) {
        const chatModelIds = this.deps.config.getModelSelection('chat');
        if (chatModelIds.length > 0) {
          this.deps.logger.warn(
            'All compaction models failed — falling back to chat models',
          );
          span.addEvent('compaction.fallback_to_chat_models_after_failure');
          const fallbackResult = await this.deps.generateText({
            modelIds: chatModelIds,
            system: COMPACTION_SYSTEM_PROMPT,
            prompt: transcript,
          });

          if (!fallbackResult.success) {
            if (fallbackResult.failureReason === 'content-filter') {
              this.deps.logger.warn(
                'Chat model fallback also returned content-filter — compaction aborted',
              );
            }
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
    const summaryMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [createDataPart(CONTEXT_SUMMARY_KEY, { summary })],
    } as unknown as ExtendedUIMessage;

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

    this.latestSummary = summary;
    span.setAttribute('compaction.summaryLength', summary.length);
    span.addEvent('compaction.summary_injected');
    this.deps.logger.info(
      { summaryLength: summary.length },
      'History compacted and summary injected after last slice message',
    );
    return true;
  }
}

/**
 * Counts non-summary user and assistant messages after the given
 * index in the history. Summary messages are excluded from the
 * count because they will be stripped from the transformed result.
 */
function countMessagesByRoleAfter(
  history: ExtendedUIMessage[],
  index: number,
): { userCount: number; assistantCount: number } {
  let userCount = 0;
  let assistantCount = 0;
  for (let i = index + 1; i < history.length; i++) {
    const msg = history[i];
    if (!msg || msg.parts.some((p) => isDataPartOf(CONTEXT_SUMMARY_KEY, p)))
      continue;
    if (msg.role === 'user') userCount++;
    else if (msg.role === 'assistant') assistantCount++;
  }
  return { userCount, assistantCount };
}

/** Compacts long session histories while preserving durable conversational context. */
export const createContextCompactionExt: ExtensionFactory = {
  identifier: 'io.stagewise/context-compaction',
  displayName: 'Context Compaction',
  create: (deps) => new ContextCompactionExt(deps),
};

/** Creates compaction with a purpose-specific context-size threshold. */
export function createContextCompactionExtForPurpose(
  purpose: ModelPurpose,
): ExtensionFactory {
  return {
    ...createContextCompactionExt,
    create: (deps) => new ContextCompactionExt(deps, purpose),
  };
}
