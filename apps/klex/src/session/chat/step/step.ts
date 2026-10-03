import { randomUUID } from 'node:crypto';

import type { JSONObject } from '@ai-sdk/provider';
import { type Context, context, type Span, trace } from '@opentelemetry/api';
import { isToolUIPart, type LanguageModel, type ModelMessage } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { ProviderModelResolver } from '@/provider-registry';
import {
  convertInferenceHistory,
  runInferenceContextTransformers,
  runInferenceHistoryTransformers,
} from '@/session/interaction';
import type { TelemetryMetrics } from '@/telemetry-metrics';

import type { ExtensionHandler } from '../extension-handler';
import type {
  InstinctSummary,
  ResolvedModel,
  StepCompleteEvent,
  TransformationFlags,
} from '../extensions/extension-api';
import type { InstinctResult, InstinctRunner } from '../instinct';
import type { ExtendedUIMessage } from '../message-types';
import { checkAndFixHistory } from '../utils/check-and-fix-history';
import type { ModelFallbackManager } from '../utils/model-fallback-manager';
import { startChildSpan, tracer } from '../utils/tracing';
import {
  createGenerationRunner,
  type GenerationRunner,
} from './generation-runner';

/**
 * Dependencies required to run a single step within a turn.
 *
 * The `messages` array is shared by reference across Session, Turn, and
 * Step. This is an intentional design choice. The critical window —
 * extension processing and model generation — operates on a
 * `structuredClone` copy, so extension mutations and model outputs
 * cannot corrupt the original array during generation.
 *
 * The original array is only mutated in synchronous, sequential code:
 * - Inbox drain (Turn drains deferred items at turn start)
 * - `checkAndFixHistory` (before the clone)
 * - Continue injection (between steps, synchronous)
 * - Response push (after generation completes, synchronous)
 *
 * No concurrent mutations occur because the session loop is
 * single-threaded: turns run sequentially, steps run sequentially within
 * a turn, and generation is awaited before the response is pushed.
 *
 * The `fallbackManager` is the same instance across the entire session —
 * it tracks model fallback state and cooldown. Passing it as a unit
 * (rather than individual closures) ensures the call-order protocol
 * between `getChatModelEntry`, `fallbackToNextModel`, and
 * `recordSuccessfulGeneration` is enforced by the manager's encapsulation.
 */
export interface StepDependencies {
  logger: ModuleLogger;
  turnContext: Context;
  messages: ExtendedUIMessage[];
  extensionHandler: ExtensionHandler;
  modelResolver: ProviderModelResolver;
  fallbackManager: ModelFallbackManager;
  config: Config;
  /**
   * The fallback index at the start of the turn. Used by the generation
   * runner for turn-level wrap-around detection — since model fallback
   * now spans multiple steps, wrap-around must be relative to the turn's
   * starting model, not the step's.
   */
  turnInitialFallbackIndex: number;
  sessionId: string;
  telemetryMetrics?: TelemetryMetrics;
  /**
   * Base system prompt forwarded to the generation runner.
   */
  basePrompt: string;
  /**
   * Session-scoped instinct runner. Omitted: the step never runs
   * instinct (tests, sessions without extensions).
   */
  instinctRunner?: InstinctRunner;
}

/** Abort reason that ends the turn instead of re-running the step. */
const SESSION_SHUTDOWN_ABORT_REASON = 'session_shutdown';

// Re-export so callers can import the step result type from the step module.
export type { StepCompleteEvent } from '../extensions/extension-api';

function removeMessageById(
  messages: ExtendedUIMessage[],
  messageId: string,
): void {
  const index = messages.findIndex(({ id }) => id === messageId);
  if (index !== -1) messages.splice(index, 1);
}

export interface Step {
  run(): Promise<StepCompleteEvent>;
  abortGeneration(reason?: string): void;
  /** Abort all in-flight tool executions. Use during session shutdown. */
  abortTools(): void;
}

class StepModule implements Step {
  private readonly id = randomUUID();

  private stepSpan: Span | null = null;
  private stepContext: Context | null = null;

  private generationRunner: GenerationRunner | null = null;

  /**
   * Remembers cancellation across instinct and asynchronous preparation,
   * before a generation runner exists to receive it.
   */
  private readonly stepAbort = new AbortController();

  constructor(private readonly deps: StepDependencies) {
    deps.logger.trace(
      {
        'event.name': 'session.step.created',
        stepId: this.id,
        sessionId: deps.sessionId,
      },
      'Session step created',
    );
  }

  async run(): Promise<StepCompleteEvent> {
    // Lazy span creation: spans are created at run() time to prevent
    // span leaks if run() is never called (e.g. abort before execution).
    const stepSpan = tracer.startSpan(
      'step',
      {
        attributes: {
          'step.id': this.id,
          'step.messageCount': this.deps.messages.length,
        },
      },
      this.deps.turnContext,
    );
    this.stepSpan = stepSpan;
    this.stepContext = trace.setSpan(this.deps.turnContext, stepSpan);

    try {
      return await context.with(this.stepContext, async () => {
        let instinctSummary: InstinctSummary | undefined;
        const complete = async (event: StepCompleteEvent) => {
          const result: StepCompleteEvent = {
            ...event,
            ...(instinctSummary !== undefined && {
              instinct: instinctSummary,
            }),
          };
          await this.deps.extensionHandler.runStepCompleteHooks(result);
          return result;
        };
        const abortPreparation = () =>
          complete({
            shouldContinue:
              this.stepAbort.signal.reason !== SESSION_SHUTDOWN_ABORT_REASON,
            forceNextStep: false,
            fatalError: false,
            fatalErrorReason: null,
            generationFailed: false,
            generation: null,
            toolCalls: [],
            modelFallbackOccurred: false,
            requestRejected: false,
            instinctAborted: true,
          });

        // 2.2.1: Notify extensions that a step is starting. This fires
        // before any processing — inbox drain, history repair, or the
        // step decision — so extensions can reset per-step state.
        await this.deps.extensionHandler.runStepStartHooks();
        if (this.stepAbort.signal.aborted) return abortPreparation();

        // 2.2.2.1: Repair history before making any step decision.
        // This ensures that any tool calls left in an intermediate state
        // (e.g. `input-available` from a crashed prior step) are resolved
        // to `output-error` before `canStepBeExecuted` evaluates them.
        // Without this, a stale tool call would cause `canStepBeExecuted`
        // to return false, skipping the step and permanently stucking the
        // session.
        const repairResult = checkAndFixHistory(this.deps.messages);
        if (repairResult.repaired.length > 0) {
          stepSpan.addEvent('step.history_repaired', {
            'step.repairCount': repairResult.repaired.length,
          });
          this.deps.logger.warn(
            { stepId: this.id, repairCount: repairResult.repaired.length },
            'History fixes applied before step decision',
          );
        }

        // 2.2.3: check if the step can be executed — trace the decision
        const decisionSpan = startChildSpan('step.decision', {
          attributes: {
            'step.id': this.id,
            'step.messageCount': this.deps.messages.length,
          },
        });

        const canRunStep = this.canStepBeExecuted();
        const lastMsg = this.deps.messages[this.deps.messages.length - 1];
        const lastRole = lastMsg?.role ?? 'none';
        const lastMsgHasToolCalls =
          lastMsg?.role === 'assistant' &&
          lastMsg.parts.some((p) => isToolUIPart(p));

        let decisionReason: string;
        if (canRunStep) {
          decisionReason =
            lastRole === 'user'
              ? 'last message is user input'
              : 'last assistant message has all tool calls resolved';
        } else {
          decisionReason =
            lastRole === 'none'
              ? 'no messages in history'
              : lastRole === 'assistant' && !lastMsgHasToolCalls
                ? 'last assistant message has no tool calls'
                : 'last assistant message has unresolved tool calls';
        }

        decisionSpan.setAttributes({
          'decision.canRunStep': canRunStep,
          'decision.reason': decisionReason,
          'decision.lastMessageRole': lastRole,
          'decision.lastMessageHasToolCalls': lastMsgHasToolCalls,
        });
        decisionSpan.addEvent('decision.evaluated', {
          'decision.result': canRunStep ? 'proceed' : 'skip',
          'decision.reason': decisionReason,
        });
        decisionSpan.end();

        this.deps.logger.debug(
          { stepId: this.id, canRunStep, reason: decisionReason, lastRole },
          'Step decision',
        );

        if (!canRunStep) {
          stepSpan.setAttribute('step.skipped', true);
          stepSpan.setAttribute('step.skipReason', decisionReason);
          stepSpan.addEvent('step.skipped', { reason: decisionReason });

          // Fire onStepComplete even on the skip path so extensions
          // receive a consistent callback for every step outcome.
          const skipEvent: StepCompleteEvent = {
            shouldContinue: false,
            forceNextStep: false,
            fatalError: false,
            fatalErrorReason: null,
            generationFailed: false,
            generation: null,
            toolCalls: [],
            modelFallbackOccurred: false,
            requestRejected: false,
          };
          return complete(skipEvent);
        }

        // 2.2.3.1: Instinct — shared classification and extension
        // reactions. Runs after the decision (skipped steps never classify)
        // and before model resolution. Persistent parts are committed here
        // synchronously; provisional and ephemeral parts are applied below.
        const instinct = await this.runInstinct(stepSpan);
        instinctSummary =
          instinct.status !== 'skipped' ? instinct.summary : undefined;
        if (instinct.status === 'aborted' || this.stepAbort.signal.aborted)
          return abortPreparation();
        const instinctProvisional =
          instinct.status === 'ready' ? instinct.provisional : [];
        const instinctEphemeral =
          instinct.status === 'ready' ? instinct.ephemeral : [];

        // 2.2.4: Fetch the model BEFORE the transformation pipeline so
        // that extension transformers receive model metadata (displayName,
        // contextSize) and can make model-aware decisions. The transformed
        // data is bound to this specific model's capabilities.
        let model: LanguageModel;
        let resolvedModel: ResolvedModel;
        let providerOptions: Record<string, JSONObject> | undefined;
        let telemetryModelContext: {
          providerType: string;
          providerId: string;
          modelId: string;
        };
        let selectedModelId: string | undefined;
        {
          const entry = this.deps.fallbackManager.getChatModelEntry();
          if (entry === undefined) {
            stepSpan.addEvent('step.no_model_configured');
            this.deps.logger.warn(
              { sessionId: this.deps.sessionId },
              'Step skipped: no chat model is configured; configure modelSelection.chat to continue',
            );
            const noModelEvent: StepCompleteEvent = {
              shouldContinue: false,
              forceNextStep: false,
              fatalError: false,
              fatalErrorReason: null,
              generationFailed: false,
              generation: null,
              toolCalls: [],
              modelFallbackOccurred: false,
              requestRejected: false,
            };
            return complete(noModelEvent);
          }
          const modelId = entry.modelId;
          selectedModelId = modelId;
          const modelSpan = startChildSpan('fetch_model', {
            attributes: {
              'model.id': modelId,
              'model.fallbackIndex':
                this.deps.fallbackManager.getFallbackIndex(),
            },
          });
          try {
            model = await this.getModel();
            const resolved = this.deps.modelResolver.resolveModel(entry);
            const info = this.deps.modelResolver.resolveModelInfo(entry);
            providerOptions = resolved.providerOptions as
              | Record<string, JSONObject>
              | undefined;
            telemetryModelContext = {
              providerType: resolved.providerType,
              providerId: resolved.providerId,
              modelId: resolved.modelId,
            };
            resolvedModel = {
              reference: entry,
              modelId,
              displayName: info.displayName,
              contextSize: info.contextSize,
              inputCapabilities: info.inputCapabilities,
            };
          } catch (error) {
            modelSpan.recordException(error as Error);
            modelSpan.setAttribute('model.unusable', true);
            modelSpan.end();
            if (this.stepAbort.signal.aborted) return abortPreparation();
            stepSpan.addEvent('step.model_resolution_failed', {
              'model.id': modelId,
              'model.fallbackIndex':
                this.deps.fallbackManager.getFallbackIndex(),
            });
            this.deps.logger.warn(
              { modelId, error },
              'Selected model is unusable; advancing to the next configured model',
            );
            this.deps.fallbackManager.fallbackToNextModel();
            const unusableModelEvent: StepCompleteEvent = {
              shouldContinue: true,
              forceNextStep: false,
              fatalError: false,
              fatalErrorReason: null,
              generationFailed: false,
              generation: null,
              toolCalls: [],
              modelFallbackOccurred: true,
              requestRejected: false,
            };
            return complete(unusableModelEvent);
          }
          modelSpan.end();
        }
        if (this.stepAbort.signal.aborted) return abortPreparation();
        stepSpan.setAttribute('step.modelId', selectedModelId ?? 'unknown');
        stepSpan.setAttribute(
          'step.modelFallbackIndex',
          this.deps.fallbackManager.getFallbackIndex(),
        );

        // Context is prepared after the step decision and model resolution so
        // it is fresh for this exact attempt. The synthetic message is visible
        // to generation immediately, but remains provisional until the runner
        // completes without failure or step-level fallback.
        let provisionalContext: Awaited<
          ReturnType<ExtensionHandler['getProvisionalStepContext']>
        >;
        try {
          provisionalContext =
            await this.deps.extensionHandler.getProvisionalStepContext(
              this.deps.messages,
              resolvedModel,
            );
        } catch (error) {
          if (this.stepAbort.signal.aborted) return abortPreparation();
          stepSpan.setAttribute('step.cancelled', true);
          stepSpan.setAttribute(
            'step.cancelReason',
            'provisional step context error',
          );
          stepSpan.addEvent('step.cancelled', {
            reason: 'provisional step context error',
          });
          this.deps.logger.error(
            { stepId: this.id, error },
            'Step cancelled: provisional step context failed',
          );
          const cancelEvent: StepCompleteEvent = {
            shouldContinue: false,
            forceNextStep: false,
            fatalError: true,
            fatalErrorReason:
              'A provisional step context extension failed; context integrity cannot be guaranteed.',
            generationFailed: false,
            generation: null,
            toolCalls: [],
            modelFallbackOccurred: false,
            requestRejected: false,
          };
          return complete(cancelEvent);
        }

        if (this.stepAbort.signal.aborted) return abortPreparation();

        // Instinct's provisional parts share the step's provisional
        // message and its retain/rollback rules.
        const provisionalParts = [
          ...instinctProvisional,
          ...provisionalContext.parts,
        ];
        const provisionalMessageId =
          provisionalParts.length > 0 ? randomUUID() : null;
        if (provisionalMessageId !== null) {
          this.deps.messages.push({
            id: provisionalMessageId,
            role: 'user',
            parts: provisionalParts,
          });
          stepSpan.addEvent('step.provisional_context_appended', {
            'step.provisionalContextPartCount': provisionalParts.length,
          });
        }

        let retainProvisionalContext = false;
        try {
          // 2.2.5 - 2.2.7: History preparation pipeline. A single span covers
          // the entire pipeline (copy → pre-process → convert → post-process)
          // with events marking each stage. This gives one contiguous trace
          // segment for the transformation with clear sub-step timing via
          // event timestamps. History repair is performed earlier (before
          // the step decision) so that `canStepBeExecuted` sees a clean
          // state.
          const transformSpan = startChildSpan('history_transformation', {
            attributes: {
              'history.inputMessageCount': this.deps.messages.length,
              'history.repairCount': repairResult.repaired.length,
            },
          });

          // --- Stage 1: Copy ---
          transformSpan.addEvent('history_copy.start');
          const messagesCopy = structuredClone(this.deps.messages);
          // Ephemeral instinct parts exist only in this attempt's clone.
          if (instinctEphemeral.length > 0) {
            messagesCopy.push({
              id: randomUUID(),
              role: 'user',
              parts: structuredClone(instinctEphemeral),
            });
          }
          transformSpan.addEvent('history_copy.end', {
            'history_copy.messageCount': messagesCopy.length,
          });

          // --- Stage 2: History transformers (extensions) ---
          transformSpan.addEvent('history_pre_process.start');
          let preResult: {
            history: ExtendedUIMessage[];
            flags: TransformationFlags;
          };
          try {
            preResult = await runInferenceHistoryTransformers(
              this.deps.extensionHandler,
              messagesCopy,
              resolvedModel,
            );
          } catch (error) {
            transformSpan.setAttribute('history_pre_process.error', true);
            transformSpan.end();
            if (this.stepAbort.signal.aborted) return abortPreparation();
            stepSpan.setAttribute('step.cancelled', true);
            stepSpan.setAttribute(
              'step.cancelReason',
              'history transformer error',
            );
            stepSpan.addEvent('step.cancelled', {
              reason: 'history transformer error',
            });
            this.deps.logger.error(
              { stepId: this.id, error },
              'Step cancelled: history transformer failed, context integrity cannot be guaranteed',
            );
            const cancelEvent: StepCompleteEvent = {
              shouldContinue: false,
              forceNextStep: false,
              fatalError: true,
              fatalErrorReason:
                'A history transformer extension failed; context integrity cannot be guaranteed.',
              generationFailed: false,
              generation: null,
              toolCalls: [],
              modelFallbackOccurred: false,
              requestRejected: false,
            };
            return complete(cancelEvent);
          }
          if (this.stepAbort.signal.aborted) {
            transformSpan.end();
            return abortPreparation();
          }
          transformSpan.setAttribute(
            'history_pre_process.messageCount',
            preResult.history.length,
          );
          transformSpan.setAttribute(
            'history_pre_process.hasCompacted',
            preResult.flags.hasCompacted === true,
          );
          this.deps.telemetryMetrics?.updateSession(this.deps.sessionId, {
            historyLength: this.deps.messages.length,
            transformedHistoryLength: preResult.history.length,
          });
          transformSpan.addEvent('history_pre_process.end', {
            'history_pre_process.messageCount': preResult.history.length,
            'history_pre_process.hasCompacted':
              preResult.flags.hasCompacted === true,
          });

          // --- Stage 3: Convert to model messages ---
          transformSpan.addEvent('history_convert.start');
          let modelMessages: ModelMessage[] = await convertInferenceHistory(
            this.deps.extensionHandler,
            preResult.history,
          );
          if (this.stepAbort.signal.aborted) {
            transformSpan.end();
            return abortPreparation();
          }
          transformSpan.addEvent('history_convert.end', {
            'history_convert.outputMessageCount': modelMessages.length,
          });

          // --- Stage 4: Context transformers (extensions) ---
          transformSpan.addEvent('history_post_process.start');
          let postResult: {
            history: ModelMessage[];
            flags: TransformationFlags;
          };
          try {
            postResult = await runInferenceContextTransformers(
              this.deps.extensionHandler,
              modelMessages,
              resolvedModel,
            );
          } catch (error) {
            transformSpan.setAttribute('history_post_process.error', true);
            transformSpan.end();
            if (this.stepAbort.signal.aborted) return abortPreparation();
            stepSpan.setAttribute('step.cancelled', true);
            stepSpan.setAttribute(
              'step.cancelReason',
              'context transformer error',
            );
            stepSpan.addEvent('step.cancelled', {
              reason: 'context transformer error',
            });
            this.deps.logger.error(
              { stepId: this.id, error },
              'Step cancelled: context transformer failed, context integrity cannot be guaranteed',
            );
            const cancelEvent: StepCompleteEvent = {
              shouldContinue: false,
              forceNextStep: false,
              fatalError: true,
              fatalErrorReason:
                'A context transformer extension failed; context integrity cannot be guaranteed.',
              generationFailed: false,
              generation: null,
              toolCalls: [],
              modelFallbackOccurred: false,
              requestRejected: false,
            };
            return complete(cancelEvent);
          }
          transformSpan.setAttribute(
            'history_post_process.messageCount',
            postResult.history.length,
          );
          transformSpan.addEvent('history_post_process.end', {
            'history_post_process.messageCount': postResult.history.length,
          });

          modelMessages = postResult.history;
          const compacted = preResult.flags.hasCompacted === true;

          transformSpan.setAttribute(
            'history_transformation.outputMessageCount',
            modelMessages.length,
          );
          transformSpan.end();

          stepSpan.addEvent('step.history_prepared', {
            'step.messageCount': modelMessages.length,
          });

          if (this.stepAbort.signal.aborted) return abortPreparation();

          // 2.2.8: Resolve tools and system prompt parts from extensions
          // for the current model, then run generation via the
          // GenerationRunner. The runner owns the retry loop, model
          // fallback, error classification, message salvage, stream
          // progress tracking, and tool dispatch coordination.
          const tools = this.deps.extensionHandler.getTools(resolvedModel);
          const extensionSystemPromptParts =
            this.deps.extensionHandler.getSystemPromptParts();
          if (this.stepAbort.signal.aborted) return abortPreparation();
          const runner = createGenerationRunner({
            logger: this.deps.logger,
            sessionId: this.deps.sessionId,
            stepSpan,
            modelMessages,
            messages: this.deps.messages,
            tools,
            extensionSystemPromptParts,
            basePrompt: this.deps.basePrompt,
            fallbackManager: this.deps.fallbackManager,
            turnInitialFallbackIndex: this.deps.turnInitialFallbackIndex,
            compacted,
            model,
            modelContext: telemetryModelContext,
            telemetryMetrics: this.deps.telemetryMetrics,
            ...(providerOptions !== undefined && { providerOptions }),
          });
          // No await between this check, publishing the runner, and run().
          // Earlier cancellation must not start generation; later cancellation
          // is forwarded directly by abortGeneration().
          if (this.stepAbort.signal.aborted) return abortPreparation();
          this.generationRunner = runner;

          try {
            const result = await runner.run();
            retainProvisionalContext =
              !result.generationFailed &&
              !result.modelFallbackOccurred &&
              !result.requestRejected &&
              !result.fatalError;
            if (result.requestRejected) {
              stepSpan.setAttribute('step.requestRejected', true);
            }
            // Notify extensions that a step completed. The handler catches
            // per-extension errors and runs all hooks in parallel, so this
            // won't break the turn.
            return await complete(result);
          } finally {
            this.generationRunner = null;
          }
        } finally {
          if (!retainProvisionalContext && provisionalMessageId !== null) {
            removeMessageById(this.deps.messages, provisionalMessageId);
            stepSpan.addEvent('step.provisional_context_rolled_back');
          }
        }
      });
    } finally {
      this.stepSpan?.end();
    }
  }

  abortGeneration(reason?: string): void {
    if (!this.stepAbort.signal.aborted) {
      this.stepAbort.abort(reason ?? 'unknown');
    }
    this.generationRunner?.abort(reason);
    this.stepSpan?.addEvent('step.generation_aborted', {
      'step.abortReason': reason ?? 'unknown',
    });
  }

  abortTools(): void {
    this.generationRunner?.abortTools();
  }

  // ---------------------------------------------------------------------------
  // Instinct
  // ---------------------------------------------------------------------------

  /**
   * Runs instinct and commits its persistent parts. Skipped when no runner
   * is wired or no chat model is configured (the step would return right
   * after without generating, so classification would be wasted).
   */
  private async runInstinct(stepSpan: Span): Promise<InstinctResult> {
    const runner = this.deps.instinctRunner;
    if (
      runner === undefined ||
      this.deps.fallbackManager.getChatModelEntry() === undefined
    ) {
      return { status: 'skipped' };
    }
    const result = await runner.run({
      history: this.deps.messages,
      signal: this.stepAbort.signal,
    });
    if (result.status === 'skipped') return result;

    stepSpan.addEvent('step.instinct', {
      'instinct.status': result.status,
      'instinct.classifierStatus': result.summary.classifierStatus,
      'instinct.durationMs': result.summary.durationMs,
    });
    this.deps.logger.debug(
      { stepId: this.id, status: result.status, summary: result.summary },
      'Step instinct finished',
    );

    // A late abort (after reactions settled, before commit) still wins:
    // nothing is committed and the step re-runs.
    if (result.status === 'ready' && this.stepAbort.signal.aborted) {
      return { status: 'aborted', summary: result.summary };
    }
    if (result.status === 'ready') {
      result.commit(this.deps.messages);
      if (result.persistent.length > 0) {
        stepSpan.addEvent('step.instinct_committed', {
          'instinct.persistentMessageCount': result.persistent.length,
        });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Step decision
  // ---------------------------------------------------------------------------

  private canStepBeExecuted(): boolean {
    const lastMsg = this.deps.messages[this.deps.messages.length - 1];

    if (lastMsg?.role === 'user') return true;

    if (lastMsg?.role === 'assistant') {
      const toolCallParts = lastMsg.parts.filter((p) => isToolUIPart(p));
      if (toolCallParts.length === 0) return false;

      const allToolCallsInValidState = toolCallParts.every(
        (p) =>
          p.state === 'output-available' ||
          p.state === 'output-denied' ||
          p.state === 'output-error' ||
          p.state === 'approval-responded',
      );
      if (allToolCallsInValidState) return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Model selection
  // ---------------------------------------------------------------------------

  private async getModel(): Promise<LanguageModel> {
    const entry = this.deps.fallbackManager.getChatModelEntry();
    if (!entry) {
      throw new Error('No chat model is configured');
    }
    return this.deps.modelResolver.getLanguageModel(entry);
  }
}

export function createStep(deps: StepDependencies): Step {
  return new StepModule(deps);
}
