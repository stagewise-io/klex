import type { Span } from '@opentelemetry/api';
import type { LanguageModel, ModelMessage } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelProvider } from '@/model-provider';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';
import {
  classifyGenerationError,
  type GenerationErrorClassification,
} from '@/utils/llm';

import type { ModelFallbackManager } from '../utils/model-fallback-manager';
import { repairPartialMessage } from '../utils/repair-partial-message';
import { runStreamedGeneration } from '../utils/run-streamed-generation';
import { startChildSpan } from '../utils/tracing';
import { ToolDispatcher } from './tool-dispatcher';

export interface GenerationRunnerResult {
  /** True if the turn should run another step after this one. */
  shouldContinue: boolean;
  /** True if the turn must inject a "Continue." message before the next step. */
  forceNextStep: boolean;
  /** True if the step failed with a fatal (non-recoverable) error. */
  fatalError: boolean;
  /** Human-readable reason for the fatal error, if fatalError is true. */
  fatalErrorReason: string | null;
  /** True if generation was attempted but all retries exhausted without usable output. */
  generationFailed: boolean;
  /** Token usage from the successful generation, if any. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface GenerationRunnerDependencies {
  logger: ModuleLogger;
  sessionId: string;
  stepSpan: Span;
  modelMessages: ModelMessage[];
  messages: ExtendedUIMessage[];
  tools: AgentTools;
  modelProvider: ModelProvider;
  fallbackManager: ModelFallbackManager;
  compacted: boolean;
  /** Initial model to use for the first attempt. */
  model: LanguageModel;
}

/** Outcome of a single generation attempt inside the retry loop. */
type GenerationOutcome =
  | 'done'
  | 'fatal'
  | 'salvage'
  | 'fallback_retry'
  | 'generation_failed';

/**
 * Coarse decision from {@link decideOutcome}. Refined to a
 * {@link GenerationOutcome} by {@link applyOutcome} after performing side
 * effects (e.g. model fallback wrap-around check).
 */
type CoarseOutcome = 'fatal' | 'salvage' | 'model_error' | 'generation_failed';

/**
 * Runs the generation retry loop for a single step.
 *
 * Owns the retry loop, model fallback, error classification, message salvage,
 * stream progress tracking, and tool dispatch coordination. The Step creates
 * a GenerationRunner after preparing the history and fetching the initial
 * model, then delegates to {@link run}.
 */
export class GenerationRunner {
  private generationAbortController: AbortController | null = null;
  private toolDispatcher: ToolDispatcher | null = null;

  constructor(private readonly deps: GenerationRunnerDependencies) {}

  async run(): Promise<GenerationRunnerResult> {
    const { stepSpan, fallbackManager, messages } = this.deps;

    const toolDispatcher = new ToolDispatcher({
      logger: this.deps.logger,
      tools: this.deps.tools,
      modelMessages: this.deps.modelMessages,
      sessionId: this.deps.sessionId,
    });
    this.toolDispatcher = toolDispatcher;

    let latestMessage: ExtendedUIMessage | null = null;

    const MAX_GENERATION_ATTEMPTS = 20;
    const initialFallbackIndex = fallbackManager.getFallbackIndex();
    let attempt = 0;
    let forceNextStep = false;
    let fatalError = false;
    let fatalErrorReason: string | null = null;
    let generationFailed = false;

    let model = this.deps.model;
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null;

    while (attempt < MAX_GENERATION_ATTEMPTS) {
      attempt++;
      const generationAbortController = new AbortController();
      this.generationAbortController = generationAbortController;

      stepSpan.addEvent('step.generation_attempt', {
        'generation.attempt': attempt,
        'generation.modelId': fallbackManager.getChatModelId(),
        'generation.modelFallbackIndex': fallbackManager.getFallbackIndex(),
      });

      let outcome: GenerationOutcome = 'done';
      let lastClassification: GenerationErrorClassification | null = null;

      // Track stream progress to make the gap between handing off
      // to the SDK and the first chunk arriving visible in traces.
      let firstChunkReceived = false;
      let chunkCount = 0;

      stepSpan.addEvent('step.generation_invoked', {
        'generation.attempt': attempt,
      });

      try {
        const response = await runStreamedGeneration({
          model,
          modelMessages: this.deps.modelMessages,
          tools: this.deps.tools,
          abortSignal: generationAbortController.signal,
          logger: this.deps.logger,
          getChatModelId: () => fallbackManager.getChatModelId(),
          sessionId: this.deps.sessionId,
          compacted: this.deps.compacted,
          onUpdate: (msg) => {
            chunkCount++;
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              stepSpan.addEvent('step.first_chunk_received', {
                'generation.attempt': attempt,
                'generation.chunkCount': 1,
                'generation.partCount': msg.parts.length,
              });
            }
            latestMessage = msg;
            toolDispatcher.onUpdate(msg);
          },
        });
        stepSpan.setAttribute('step.chunkCount', chunkCount);
        latestMessage = response.message;

        stepSpan.addEvent('step.generation_finished', {
          'generation.finishReason': response.finishReason,
          'generation.usage.inputTokens': response.usage.inputTokens,
          'generation.usage.outputTokens': response.usage.outputTokens,
          'generation.attempt': attempt,
        });
        stepSpan.setAttribute('step.finishReason', response.finishReason);
        stepSpan.setAttribute(
          'step.toolCallCount',
          toolDispatcher.dispatchedCount,
        );

        // Good finish — we're done.
        if (
          response.finishReason === 'stop' ||
          response.finishReason === 'tool-calls'
        ) {
          messages.push(response.message);
          fallbackManager.recordSuccessfulGeneration();
          lastUsage = {
            inputTokens: response.usage.inputTokens ?? 0,
            outputTokens: response.usage.outputTokens ?? 0,
          };
          // outcome stays 'done' — will break below.
        } else {
          // Non-good finish — classify only on 'error' finish reason.
          const classification =
            response.finishReason === 'error'
              ? classifyGenerationError(response.error)
              : null;
          lastClassification = classification;
          const hasContent =
            response.message !== null && response.message.parts.length > 0;
          const coarse = this.decideOutcome(classification, hasContent);
          outcome = this.applyOutcome(
            coarse,
            attempt,
            initialFallbackIndex,
            classification,
            response.message,
            response.finishReason,
          );
        }
      } catch (e) {
        stepSpan.setAttribute('step.chunkCount', chunkCount);
        stepSpan.recordException(e as Error);
        stepSpan.setAttribute('step.error', String(e));
        this.deps.logger.error({ attempt }, 'Generation failed', e);

        const classification = classifyGenerationError(e);
        lastClassification = classification;
        const hasContent =
          latestMessage !== null && latestMessage.parts.length > 0;
        const coarse = this.decideOutcome(classification, hasContent);
        outcome = this.applyOutcome(
          coarse,
          attempt,
          initialFallbackIndex,
          classification,
          latestMessage,
          'exception',
        );
      }

      // Shared outcome handling.
      if (outcome === 'done') break;
      if (outcome === 'fatal') {
        fatalError = true;
        fatalErrorReason = lastClassification?.reason ?? 'unknown fatal error';
        break;
      }
      if (outcome === 'salvage') {
        forceNextStep = true;
        break;
      }
      if (outcome === 'generation_failed') {
        generationFailed = true;
        break;
      }
      // fallback_retry — refresh model and continue.
      model = await this.deps.modelProvider.get(
        fallbackManager.getChatModelId(),
      );
      stepSpan.setAttribute('step.modelId', fallbackManager.getChatModelId());
    }

    // If the retry loop exited due to hitting the attempt cap (not via
    // break), no message was pushed and forceNextStep is still false.
    if (generationFailed || attempt >= MAX_GENERATION_ATTEMPTS) {
      stepSpan.addEvent('step.generation_attempts_exhausted', {
        'generation.attempt': attempt,
      });
      this.deps.logger.error(
        { attempt },
        'Generation attempts exhausted — stopping step',
      );
      return {
        shouldContinue: false,
        forceNextStep: false,
        fatalError: false,
        fatalErrorReason: null,
        generationFailed: true,
        usage: null,
      };
    }

    // Post-generation tool sweep: catch tool calls that were fully
    // streamed but not yet dispatched (e.g. due to abort mid-stream).
    const sweptToolCount = toolDispatcher.sweep(latestMessage);
    if (sweptToolCount > 0) {
      stepSpan.addEvent('step.tools_swept', {
        'step.sweptToolCount': sweptToolCount,
      });
      this.deps.logger.debug(
        { sweptToolCount },
        'Post-generation tool sweep dispatched additional tool calls',
      );
    }

    // Wait for all in-flight tool executions to finish before step ends.
    await toolDispatcher.settle();
    stepSpan.addEvent('step.tools_settled', {
      'step.toolCallCount': toolDispatcher.inFlightCount,
    });

    stepSpan.setAttribute('step.forceNextStep', forceNextStep);
    if (forceNextStep) {
      stepSpan.addEvent('step.force_continue', {});
    }

    return {
      shouldContinue: true,
      forceNextStep,
      fatalError,
      fatalErrorReason,
      generationFailed,
      usage: lastUsage,
    };
  }

  abort(reason?: string): void {
    this.generationAbortController?.abort();
    this.deps.stepSpan.addEvent('step.generation_aborted', {
      'step.abortReason': reason ?? 'unknown',
    });
  }

  /** Abort all in-flight tool executions. Use during session shutdown. */
  abortTools(): void {
    this.toolDispatcher?.abortTools();
  }

  // ---------------------------------------------------------------------------
  // Generation failure handling
  // ---------------------------------------------------------------------------

  /**
   * Pure decision function: maps classification + content state to a coarse
   * outcome without performing any side effects. The caller passes the
   * result to {@link applyOutcome}, which refines it into a final
   * {@link GenerationOutcome} after performing side effects.
   */
  private decideOutcome(
    classification: GenerationErrorClassification | null,
    hasContent: boolean,
  ): CoarseOutcome {
    // Fatal — terminate immediately, no salvage.
    if (classification?.isFatal) return 'fatal';

    // Content produced (even partial) — salvage, force next step.
    if (hasContent) return 'salvage';

    // No content + model error — needs fallback + wrap-around check.
    if (classification?.isModelError) return 'model_error';

    // No content, non-model error or non-error finish — nothing to salvage.
    return 'generation_failed';
  }

  /**
   * Performs side effects for a coarse outcome (span attributes, message
   * salvage + push, model fallback) and returns the refined
   * {@link GenerationOutcome}. The `model_error` coarse outcome is refined
   * to either `fallback_retry` or `generation_failed` depending on whether
   * all models have been tried (wrap-around check after advancing).
   */
  private applyOutcome(
    coarse: CoarseOutcome,
    attempt: number,
    initialFallbackIndex: number,
    classification: GenerationErrorClassification | null,
    message: ExtendedUIMessage | null,
    trigger: string,
  ): GenerationOutcome {
    const { stepSpan, fallbackManager, messages } = this.deps;

    if (classification) {
      stepSpan.setAttribute('step.errorClassification', classification.reason);
    }

    switch (coarse) {
      case 'fatal': {
        stepSpan.setAttribute('step.fatalError', true);
        this.deps.logger.error(
          { reason: classification?.reason },
          'Fatal generation error — session should be terminated',
        );
        return 'fatal';
      }

      case 'salvage': {
        if (message) {
          const salvaged = this.traceMessageRepair(message, trigger, attempt);
          if (salvaged) {
            messages.push(message);
            stepSpan.setAttribute('step.salvaged', true);
          } else {
            stepSpan.setAttribute('step.salvageFailed', true);
          }
        }
        if (classification?.isModelError) {
          fallbackManager.fallbackToNextModel();
          stepSpan.setAttribute('step.modelFallbackTriggered', true);
        }
        return 'salvage';
      }

      case 'model_error': {
        fallbackManager.fallbackToNextModel();
        stepSpan.setAttribute('step.modelFallbackTriggered', true);

        // All models tried — wrapped back to the starting index.
        if (fallbackManager.getFallbackIndex() === initialFallbackIndex) {
          stepSpan.addEvent('step.models_exhausted', {
            'generation.attempt': attempt,
          });
          this.deps.logger.error(
            { attempt, reason: classification?.reason },
            'All models exhausted — stopping step',
          );
          return 'generation_failed';
        }

        stepSpan.addEvent('step.fallback_retry', {
          'error.classification': classification?.reason,
          'generation.attempt': attempt,
        });
        this.deps.logger.debug(
          { attempt, reason: classification?.reason },
          'No content received, falling back to next model',
        );
        return 'fallback_retry';
      }

      case 'generation_failed': {
        return 'generation_failed';
      }
    }
  }

  /**
   * Runs repairPartialMessage under a dedicated span and returns whether the
   * message was salvaged.
   */
  private traceMessageRepair(
    message: ExtendedUIMessage,
    trigger: string,
    attempt: number,
  ): boolean {
    const beforeParts = message.parts.length;
    const span = startChildSpan('message_repair', {
      attributes: {
        'repair.type': 'partial_message',
        'repair.trigger': trigger,
        'repair.attempt': attempt,
        'repair.beforePartCount': beforeParts,
      },
    });
    const salvaged = repairPartialMessage(message);
    const afterParts = message.parts.length;
    span.setAttributes({
      'repair.salvaged': salvaged,
      'repair.afterPartCount': afterParts,
      'repair.removedPartCount': beforeParts - afterParts,
    });
    span.end();
    return salvaged;
  }
}

/**
 * Creates a GenerationRunner instance.
 *
 * Note: Unlike Step/Turn, this does not use the createXxx pattern with a
 * factory function because the class is exported directly for test access.
 */
export function createGenerationRunner(
  deps: GenerationRunnerDependencies,
): GenerationRunner {
  return new GenerationRunner(deps);
}
