import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';
import { isToolUIPart, type LanguageModel, type ModelMessage } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelProvider } from '@/model-provider';
import { type SessionInboxBuffer, SessionInboxPriority } from '@/session/inbox';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';

import type { ExtensionHandler } from '../extension-handler';
import type { StepCompleteEvent } from '../extensions/extension-api';
import { checkAndFixHistory } from '../utils/check-and-fix-history';
import { convertToModelMessagesExtended } from '../utils/convert-to-model-messages';
import { inboxDrainAttributes } from '../utils/inbox-drain-attributes';
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
 * - Inbox drain (at the start of each layer: Turn drains Low, Step
 *   drains Medium)
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
 * between `getChatModelId`, `fallbackToNextModel`, and
 * `recordSuccessfulGeneration` is enforced by the manager's encapsulation.
 */
export interface StepDependencies {
  logger: ModuleLogger;
  turnContext: Context;
  messages: ExtendedUIMessage[];
  inbox: SessionInboxBuffer;
  extensionHandler: ExtensionHandler;
  tools: AgentTools;
  modelProvider: ModelProvider;
  fallbackManager: ModelFallbackManager;
  sessionId: string;
}

// Re-export so callers can import the step result type from the step module.
export type {
  StepCompleteEvent,
  StepCompleteEvent as StepResult,
} from '../extensions/extension-api';

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

  constructor(private readonly deps: StepDependencies) {
    deps.logger.trace('START_STEP', { id: this.id });
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
        // 2.2.2: fetch inbox
        const drained = this.deps.inbox.drain(
          this.deps.messages,
          SessionInboxPriority.Medium,
          this.deps.logger,
        );
        stepSpan.addEvent(
          'step.inbox_drained',
          inboxDrainAttributes(drained, 'medium'),
        );

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
          };
          await this.deps.extensionHandler.runStepCompleteHooks(skipEvent);
          return skipEvent;
        }

        // 2.2.4 - 2.2.6: History preparation pipeline. A single span covers
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
        transformSpan.addEvent('history_copy.end', {
          'history_copy.messageCount': messagesCopy.length,
        });

        // --- Stage 2: History transformers (extensions) ---
        transformSpan.addEvent('history_pre_process.start');
        const preResult =
          await this.deps.extensionHandler.runHistoryTransformers(messagesCopy);
        transformSpan.setAttribute(
          'history_pre_process.messageCount',
          preResult.history.length,
        );
        transformSpan.setAttribute(
          'history_pre_process.hasCompacted',
          preResult.flags.hasCompacted === true,
        );
        transformSpan.addEvent('history_pre_process.end', {
          'history_pre_process.messageCount': preResult.history.length,
          'history_pre_process.hasCompacted':
            preResult.flags.hasCompacted === true,
        });

        // --- Stage 3: Convert to model messages ---
        transformSpan.addEvent('history_convert.start');
        let modelMessages: ModelMessage[] =
          await convertToModelMessagesExtended(preResult.history);
        transformSpan.addEvent('history_convert.end', {
          'history_convert.outputMessageCount': modelMessages.length,
        });

        // --- Stage 4: Context transformers (extensions) ---
        transformSpan.addEvent('history_post_process.start');
        const postResult =
          await this.deps.extensionHandler.runContextTransformers(
            modelMessages,
          );
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

        // 2.2.7: Pick right model
        let model: LanguageModel;
        {
          const modelSpan = startChildSpan('fetch_model', {
            attributes: {
              'model.id': this.deps.fallbackManager.getChatModelId(),
              'model.fallbackIndex':
                this.deps.fallbackManager.getFallbackIndex(),
            },
          });
          model = await this.getModel();
          modelSpan.end();
        }
        stepSpan.setAttribute(
          'step.modelId',
          this.deps.fallbackManager.getChatModelId(),
        );
        stepSpan.setAttribute(
          'step.modelFallbackIndex',
          this.deps.fallbackManager.getFallbackIndex(),
        );

        // 2.2.8: Run generation via the GenerationRunner.
        // The runner owns the retry loop, model fallback, error
        // classification, message salvage, stream progress tracking,
        // and tool dispatch coordination.
        const runner = createGenerationRunner({
          logger: this.deps.logger,
          sessionId: this.deps.sessionId,
          stepSpan,
          modelMessages,
          messages: this.deps.messages,
          tools: this.deps.tools,
          modelProvider: this.deps.modelProvider,
          fallbackManager: this.deps.fallbackManager,
          compacted,
          model,
        });
        this.generationRunner = runner;

        try {
          const result = await runner.run();
          // Notify extensions that a step completed. The handler catches
          // per-extension errors and runs all hooks in parallel, so this
          // won't break the turn.
          const hookResult =
            await this.deps.extensionHandler.runStepCompleteHooks(result);
          // If any extension requested a stop, override shouldContinue.
          if (hookResult.stop) {
            result.shouldContinue = false;
          }
          return result;
        } finally {
          this.generationRunner = null;
        }
      });
    } finally {
      this.stepSpan?.end();
    }
  }

  abortGeneration(reason?: string): void {
    this.generationRunner?.abort(reason);
    this.stepSpan?.addEvent('step.generation_aborted', {
      'step.abortReason': reason ?? 'unknown',
    });
  }

  abortTools(): void {
    this.generationRunner?.abortTools();
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
    const modelId = this.deps.fallbackManager.getChatModelId();
    return this.deps.modelProvider.get(modelId);
  }
}

export function createStep(deps: StepDependencies): Step {
  return new StepModule(deps);
}
