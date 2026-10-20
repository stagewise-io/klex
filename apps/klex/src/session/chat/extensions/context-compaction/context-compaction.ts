import { context, type Span, trace } from '@opentelemetry/api';

import type { ModelPurpose } from '@/config';
import { isCheckpointHeader } from '@/session/chat/checkpoint';
import {
  CONTEXT_SUMMARY_KEY,
  createTranscriptHistoryView,
  LINES_FORMAT_PROMPT,
} from '@/session/chat/utils/history-view';

import type { ExtendedUIMessage } from '../../message-types';
import { startChildSpan } from '../../utils/tracing';
import {
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  isDataPartOf,
  type StepCompleteEvent,
} from '../extension-api';
import compactionPrompt from './compaction-prompt.md';

const COMPACTION_TRANSCRIPT_VIEW = createTranscriptHistoryView();
const COMPACTION_SYSTEM_PROMPT = `${compactionPrompt}\n\n${LINES_FORMAT_PROMPT}`;

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
 * Hysteresis margin for post-compaction re-triggering. After a
 * checkpoint was applied, the inputTokens of the first subsequent
 * step become the post-compaction baseline. The next compaction
 * only triggers when the latest step's inputTokens exceed this
 * baseline by at least this fraction (0.1 = 10% growth), preventing
 * repeated compaction of a context that is already compact but
 * still large. Both the absolute threshold AND this hysteresis
 * check must be satisfied to trigger.
 */
export const COMPACTION_HYSTERESIS_RATIO = 0.1;

/**
 * Share of the compaction threshold that the raw tail (messages kept
 * verbatim after the checkpoint) may occupy.
 */
export const RAW_TAIL_THRESHOLD_RATIO = 0.2;

/** Rough serialized-characters-per-token ratio for raw tail sizing. */
export const RAW_TAIL_CHARS_PER_TOKEN = 4;

/**
 * Picks the checkpoint anchor: the message right before the raw tail.
 *
 * The raw tail is the newest run of messages whose cumulative serialized
 * size stays within `maxTailChars`, but always includes the last assistant
 * message and everything after it. When the size-bounded tail would cover
 * every raw message, the minimal tail (last assistant onward, or only the
 * newest message) is used instead so the threshold hit still frees space.
 * Returns `null` when even the minimal tail leaves nothing to cover.
 */
export function selectCheckpointAnchor(
  window: readonly ExtendedUIMessage[],
  maxTailChars: number,
): { anchorIndex: number } | null {
  const firstRawIndex = isCheckpointHeader(window[0]) ? 1 : 0;

  let tailStart = window.length;
  let tailChars = 0;
  for (let i = window.length - 1; i >= firstRawIndex; i--) {
    const message = window[i];
    if (!message) continue;
    const size = JSON.stringify(message).length;
    if (tailChars + size > maxTailChars) break;
    tailChars += size;
    tailStart = i;
  }

  const lastAssistant = window.findLastIndex(
    (message, index) => index >= firstRawIndex && message.role === 'assistant',
  );
  // Minimal tail: the last assistant onward, else only the newest message.
  const minimalStart = lastAssistant !== -1 ? lastAssistant : window.length - 1;
  tailStart = Math.min(tailStart, minimalStart);
  if (tailStart - 1 < firstRawIndex) tailStart = minimalStart;

  const anchorIndex = tailStart - 1;
  if (anchorIndex < firstRawIndex) return null;
  return { anchorIndex };
}

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
   * After a checkpoint was applied, the inputTokens of the first
   * subsequent step are captured as the post-compaction baseline.
   * The next compaction requires the latest step's inputTokens to
   * exceed this baseline by at least {@link COMPACTION_HYSTERESIS_RATIO},
   * preventing immediate re-compaction of an already-compact context.
   * Set to 0 before the first compaction or after a failed/skipped
   * compaction (no baseline → only the absolute threshold applies).
   */
  private postCompactionBaseline = 0;

  /**
   * Anchor of the last checkpoint this extension committed. While set,
   * {@link onStepComplete} waits for the window to start with a header
   * covering this anchor, captures inputTokens of that step as the
   * baseline, and clears it.
   */
  private awaitingCheckpointAnchor: string | null = null;

  private compacting = false;
  private cachedThreshold: number | null = null;
  private latestSummary: string | null = null;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly thresholdModelPurpose: ModelPurpose = 'chat',
  ) {}

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

  introspect(): Record<string, unknown> {
    return {
      status: this.compacting ? 'compacting' : 'idle',
      latestSummary: this.latestSummary,
    };
  }

  async onStepComplete(event: StepCompleteEvent): Promise<void> {
    if (event.generation === null) return;

    const inputTokens = event.generation.usage.inputTokens ?? 0;
    this.lastStepInputTokens = inputTokens;

    // The first step whose window starts with our checkpoint establishes
    // the post-compaction baseline: the measured context size after the
    // trim. The trigger check is skipped for this step because it IS the
    // baseline. Until the checkpoint is applied (core applies it at the
    // next step boundary), keep waiting.
    if (this.awaitingCheckpointAnchor !== null) {
      if (!this.windowCovers(this.awaitingCheckpointAnchor)) {
        const anchorId = this.awaitingCheckpointAnchor;
        if (!this.deps.getHistory().some((m) => m.id === anchorId)) {
          // Core dropped the checkpoint (anchor rolled back); re-arm the
          // trigger without a baseline.
          this.awaitingCheckpointAnchor = null;
          this.deps.logger.warn(
            { anchorId },
            'Committed checkpoint was not applied — re-arming compaction',
          );
        }
        this.deps.logger.debug(
          { inputTokens },
          'Awaiting baseline but checkpoint is not applied yet — deferring',
        );
        return;
      }
      this.postCompactionBaseline = inputTokens;
      this.awaitingCheckpointAnchor = null;
      this.deps.logger.info(
        { postCompactionBaseline: this.postCompactionBaseline },
        'Post-compaction baseline established from first step after checkpoint',
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

  /** True when the window header covers the given anchor. */
  private windowCovers(anchorId: string): boolean {
    const header = this.deps.getHistory()[0];
    if (!isCheckpointHeader(header)) return false;
    return (
      header?.parts.some(
        (part: { type: string; data?: unknown }) =>
          isDataPartOf<
            typeof CONTEXT_SUMMARY_KEY,
            { coversThroughMessageId?: string }
          >(CONTEXT_SUMMARY_KEY, part) &&
          part.data.coversThroughMessageId === anchorId,
      ) ?? false
    );
  }

  private async runCompaction(): Promise<void> {
    this.compacting = true;

    let span: Span | null = null;
    let committedAnchor: string | null = null;
    try {
      const childSpan = startChildSpan('context_compaction', {
        attributes: {
          'compaction.lastStepInputTokens': this.lastStepInputTokens,
          'compaction.postCompactionBaseline': this.postCompactionBaseline,
          'compaction.threshold': this.getCompactionThreshold(),
        },
      });
      span = childSpan;

      committedAnchor = await context.with(
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
      // On failure, skip, or rejection the baseline resets so the next
      // step can re-trigger without hysteresis. On success, the baseline
      // is measured once the checkpoint is applied.
      this.postCompactionBaseline = 0;
      this.awaitingCheckpointAnchor = committedAnchor;
      if (committedAnchor !== null) {
        span?.setAttribute('compaction.awaitingBaseline', true);
      }
      span?.end();
    }
  }

  /** Returns the committed anchor ID, or `null` when nothing was committed. */
  private async runCompactionInner(span: Span): Promise<string | null> {
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
        return null;
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

    const maxTailChars =
      this.getCompactionThreshold() *
      RAW_TAIL_THRESHOLD_RATIO *
      RAW_TAIL_CHARS_PER_TOKEN;
    const selection = selectCheckpointAnchor(history, maxTailChars);
    if (!selection) {
      this.deps.logger.debug(
        { totalHistory: history.length },
        'No checkpoint anchor available — skipping compaction',
      );
      span.addEvent('compaction.skipped', { reason: 'no-anchor' });
      return null;
    }

    // The slice includes a previous header, so the transcript view starts
    // at its summary and the new summary covers everything up to the anchor.
    const slice = history.slice(0, selection.anchorIndex + 1);
    span.setAttribute('compaction.sliceLength', slice.length);
    span.setAttribute(
      'compaction.rawTailLength',
      history.length - slice.length,
    );

    const transcript = COMPACTION_TRANSCRIPT_VIEW.render(slice).text;
    span.setAttribute('compaction.transcriptLength', transcript.length);

    if (transcript.trim().length === 0) {
      this.deps.logger.debug('Empty transcript — skipping compaction');
      span.addEvent('compaction.skipped', { reason: 'empty-transcript' });
      return null;
    }

    span.addEvent('compaction.transcript_ready', {
      'compaction.transcriptLength': transcript.length,
      'compaction.sliceLength': slice.length,
    });

    const anchorMessage = slice.at(-1);
    if (!anchorMessage) {
      throw new Error('Cannot record an empty compaction slice');
    }
    const anchorId = anchorMessage.id;
    span.setAttribute('compaction.lastSliceMessageId', anchorId);

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
            return null;
          }

          return this.commitCheckpoint(fallbackResult.text, anchorId, span);
        }
      }

      span.addEvent('compaction.failed', {
        reason: 'all-models-failed',
        failureReason: result.failureReason,
        failureDetails: result.failureDetails ?? '',
      });
      return null;
    }

    return this.commitCheckpoint(result.text, anchorId, span);
  }

  /** Hands the summary to core; returns the anchor when it was accepted. */
  private commitCheckpoint(
    summary: string,
    anchorId: string,
    span: Span,
  ): string | null {
    const result = this.deps.checkpoints.commit({
      coversThroughMessageId: anchorId,
      summary,
    });

    if (result.status === 'rejected') {
      // Retried on the next threshold check with a fresh anchor.
      this.deps.logger.warn(
        { anchorId, reason: result.reason },
        'Checkpoint rejected — summary dropped',
      );
      span.addEvent('compaction.checkpoint_rejected', {
        reason: result.reason,
      });
      return null;
    }

    this.latestSummary = summary;
    span.setAttribute('compaction.summaryLength', summary.length);
    span.addEvent('compaction.checkpoint_committed');
    this.deps.logger.info(
      { summaryLength: summary.length, anchorId },
      'Compaction summary committed as checkpoint',
    );
    return anchorId;
  }
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
