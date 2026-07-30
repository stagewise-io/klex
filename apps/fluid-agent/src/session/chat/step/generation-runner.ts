import type { Span } from '@opentelemetry/api';
import {
  type FinishReason,
  getToolName,
  isToolUIPart,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import {
  classifyGenerationError,
  type GenerationErrorClassification,
} from '@/utils/llm';

import type {
  StepCompleteEvent,
  ToolCallInfo,
} from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import type { AgentTools } from '../tools';
import type { ModelFallbackManager } from '../utils/model-fallback-manager';
import { repairPartialMessage } from '../utils/repair-partial-message';
import { runStreamedGeneration } from '../utils/run-streamed-generation';
import { startChildSpan } from '../utils/tracing';
import { ToolDispatcher } from './tool-dispatcher';

export interface GenerationRunnerDependencies {
  logger: ModuleLogger;
  sessionId: string;
  stepSpan: Span;
  modelMessages: ModelMessage[];
  messages: ExtendedUIMessage[];
  tools: AgentTools;
  fallbackManager: ModelFallbackManager;
  /**
   * The fallback index at the start of the turn. Used for turn-level
   * wrap-around detection — since model fallback now spans multiple
   * steps, wrap-around must be relative to the turn's starting model.
   */
  turnInitialFallbackIndex: number;
  compacted: boolean;
  /** Initial model to use for the first attempt. */
  model: LanguageModel;
}

/** Outcome of a single generation attempt inside the retry loop. */
type GenerationOutcome =
  | 'done'
  | 'fatal'
  | 'salvage'
  | 'fallback_new_step'
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
 *
 * When a model error occurs with no content, the runner advances the
 * fallback manager and returns with `modelFallbackOccurred: true` instead
 * of retrying in-loop. The turn creates a new step that re-runs the
 * transformation pipeline with the new model, since transformations are
 * bound to specific model capabilities.
 */
export class GenerationRunner {
  private generationAbortController: AbortController | null = null;
  private toolDispatcher: ToolDispatcher | null = null;

  constructor(private readonly deps: GenerationRunnerDependencies) {}

  async run(): Promise<StepCompleteEvent> {
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
    let attempt = 0;
    let forceNextStep = false;
    let fatalError = false;
    let fatalErrorReason: string | null = null;
    let generationFailed = false;
    let modelFallbackOccurred = false;

    const model = this.deps.model;
    let lastUsage: LanguageModelUsage | null = null;
    let lastFinishReason: FinishReason | null = null;
    let lastModelId: string | null = null;

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
          lastUsage = response.usage;
          lastFinishReason = response.finishReason;
          lastModelId = fallbackManager.getChatModelId();
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
      // fallback_new_step — break out so the turn creates a new step
      // that re-fetches the model and re-runs the transformation pipeline.
      modelFallbackOccurred = true;
      break;
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
        generation: null,
        toolCalls: [],
        modelFallbackOccurred: false,
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

    // Extract ToolCallInfo[] from the latest assistant message after all
    // tools have settled. Only includes tool calls in a terminal state.
    const toolCalls = extractToolCalls(latestMessage);

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
      generation:
        lastUsage !== null && lastFinishReason !== null && lastModelId !== null
          ? {
              modelId: lastModelId,
              finishReason: lastFinishReason,
              usage: lastUsage,
            }
          : null,
      toolCalls,
      modelFallbackOccurred,
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

    // No content + non-fatal → treat as model error to trigger fallback.
    // Unknown error types (DNS failures, custom provider errors, non-standard
    // HTTP codes, etc.) that don't match known AI SDK patterns would
    // otherwise fall through to generation_failed, preventing fallback from
    // ever being attempted — the session would retry the same bad model
    // forever via backoff. If all models are exhausted, the wrap-around
    // check in applyOutcome produces generation_failed anyway, so
    // defaulting to model_error ensures we actually try fallback models
    // before giving up.
    return 'model_error';
  }

  /**
   * Performs side effects for a coarse outcome (span attributes, message
   * salvage + push, model fallback) and returns the refined
   * {@link GenerationOutcome}. The `model_error` coarse outcome is refined
   * to either `fallback_new_step` or `generation_failed` depending on whether
   * all models have been tried (wrap-around check after advancing).
   */
  private applyOutcome(
    coarse: CoarseOutcome,
    attempt: number,
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

        // All models tried — wrapped back to the turn's starting index.
        if (
          fallbackManager.getFallbackIndex() ===
          this.deps.turnInitialFallbackIndex
        ) {
          stepSpan.addEvent('step.models_exhausted', {
            'generation.attempt': attempt,
          });
          this.deps.logger.error(
            { attempt, reason: classification?.reason },
            'All models exhausted — stopping step',
          );
          return 'generation_failed';
        }

        stepSpan.addEvent('step.fallback_new_step', {
          'error.classification': classification?.reason,
          'generation.attempt': attempt,
        });
        this.deps.logger.debug(
          { attempt, reason: classification?.reason },
          'No content received, falling back to next model in a new step',
        );
        return 'fallback_new_step';
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
 * Extracts settled tool call information from an assistant message's parts.
 * Only includes tool UI parts in a terminal state (`output-available`,
 * `output-error`, or `output-denied`). Returns an empty array when the
 * message is null or contains no settled tool calls.
 */
function extractToolCalls(message: ExtendedUIMessage | null): ToolCallInfo[] {
  if (!message) return [];
  const toolCalls: ToolCallInfo[] = [];
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    if (
      part.state !== 'output-available' &&
      part.state !== 'output-error' &&
      part.state !== 'output-denied'
    ) {
      continue;
    }
    const info: ToolCallInfo = {
      toolCallId: part.toolCallId,
      toolName: getToolName(part),
      input: part.input,
      state: part.state,
    };
    if (part.state === 'output-available' && part.output !== undefined) {
      info.output = part.output;
    }
    if (part.state === 'output-error' && part.errorText !== undefined) {
      info.errorText = part.errorText;
    }
    toolCalls.push(info);
  }
  return toolCalls;
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
