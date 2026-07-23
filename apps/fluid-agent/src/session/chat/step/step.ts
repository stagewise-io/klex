import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';
import { getToolName, isToolUIPart, type LanguageModel } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import { type SessionInboxBuffer, SessionInboxPriority } from '@/session/inbox';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';

import type { ExtensionHandler } from '../extension-handler';
import { checkAndFixHistory } from '../utils/check-and-fix-history';
import { classifyGenerationError } from '../utils/classify-generation-error';
import { convertToModelMessagesExtended } from '../utils/convert-to-model-messages';
import { drainInbox } from '../utils/drain-inbox';
import { executeTool } from '../utils/execute-tool';
import { repairPartialMessage } from '../utils/repair-partial-message';
import { runStreamedGeneration } from '../utils/run-streamed-generation';

export interface StepDependencies {
  logger: ModuleLogger;
  turnContext: Context;
  messages: ExtendedUIMessage[];
  inbox: SessionInboxBuffer;
  extensionHandler: ExtensionHandler;
  tools: AgentTools;
  modelProvider: ModelProvider;
  getChatModelId: () => ModelId;
  getModelFallbackIndex: () => number;
  fallbackToNextModel: () => void;
}

export interface StepResult {
  /** True if generation was executed (not skipped). */
  hadGeneration: boolean;
  /** True if the turn must run another step regardless of normal conditions. */
  forceNextStep: boolean;
}

export interface Step {
  /**
   * Runs the step. Returns a StepResult indicating whether generation
   * occurred and whether the next step must be forced.
   */
  run(): Promise<StepResult>;
  abortGeneration(): void;
}

class StepModule implements Step {
  private readonly id = randomUUID();

  private readonly stepSpan: Span;

  private readonly stepContext: Context;

  private generationAbortController: AbortController | null = null;

  constructor(private readonly deps: StepDependencies) {
    this.stepSpan = trace.getTracer('fluid-agent').startSpan(
      'step',
      {
        attributes: {
          'step.id': this.id,
          'step.messageCount': deps.messages.length,
        },
      },
      deps.turnContext,
    );
    this.stepContext = trace.setSpan(deps.turnContext, this.stepSpan);

    deps.logger.trace('START_STEP', { id: this.id });
  }

  async run(): Promise<StepResult> {
    return context.with(this.stepContext, async () => {
      // 2.2.2: fetch inbox
      const drained = drainInbox(
        this.deps.inbox,
        this.deps.messages,
        SessionInboxPriority.Medium,
        this.deps.logger,
      );
      this.stepSpan.addEvent('step.inbox_drained', {
        'inbox.minPriority': 'medium',
        'inbox.total': drained.total,
        'inbox.low': drained.byPriority.low,
        'inbox.medium': drained.byPriority.medium,
        'inbox.high': drained.byPriority.high,
      });

      // 2.2.3: check if the step can be executed — trace the decision
      const decisionSpan = trace.getTracer('fluid-agent').startSpan(
        'step.decision',
        {
          attributes: {
            'step.id': this.id,
            'step.messageCount': this.deps.messages.length,
          },
        },
        this.stepContext,
      );

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

      this.deps.logger.info(
        { stepId: this.id, canRunStep, reason: decisionReason, lastRole },
        'Step decision',
      );

      if (!canRunStep) {
        this.stepSpan.setAttribute('step.skipped', true);
        this.stepSpan.setAttribute('step.skipReason', decisionReason);
        this.stepSpan.addEvent('step.skipped', { reason: decisionReason });
        this.stepSpan.end();
        return { hadGeneration: false, forceNextStep: false };
      }

      // Make sure the history is in a functional state
      checkAndFixHistory(this.deps.messages);

      // 2.2.4 - 2.2.6: Create copy of history and run processing
      const messagesCopy = structuredClone(this.deps.messages);
      this.deps.extensionHandler.onHistoryPreProcessing(messagesCopy);
      const modelMessages = await convertToModelMessagesExtended(messagesCopy);
      this.deps.extensionHandler.onHistoryPostProcessing(modelMessages);

      this.stepSpan.addEvent('step.history_prepared', {
        'step.messageCount': modelMessages.length,
      });

      // 2.2.7: Pick right model
      const model = await this.getModel();
      this.stepSpan.setAttribute('step.modelId', this.deps.getChatModelId());
      this.stepSpan.setAttribute(
        'step.modelFallbackIndex',
        this.deps.getModelFallbackIndex(),
      );

      // Track dispatched tool calls to prevent duplicate execution.
      // A tool call is dispatched at most once — only when it reaches
      // 'input-available' state and hasn't been dispatched yet.
      const dispatchedToolCallIds = new Set<string>();
      // Track in-flight tool executions to await before step finishes
      const toolExecutions: Promise<void>[] = [];
      // Latest message from the stream — used to sweep for tool calls
      // that were fully streamed but not yet dispatched (e.g. on abort)
      let latestMessage: ExtendedUIMessage | null = null;

      // Separate abort controller for tool executions. Tools must always
      // run to completion even if the generation is aborted — the generation
      // abort only stops the stream, not in-flight or pending tool calls.
      const toolAbortController = new AbortController();

      /**
       * Dispatch a single tool call for execution if it hasn't been
       * dispatched yet. Called both during streaming (via onUpdate) and
       * after generation completes/aborts (via the post-generation sweep).
       *
       * Guards (at-most-once execution):
       * - Not a tool UI part → skip
       * - Provider-executed → skip
       * - Not in 'input-available' state → skip (already executing or done)
       * - Already in dispatchedToolCallIds → skip (race protection)
       */
      const dispatchToolCall = (
        part: ExtendedUIMessage['parts'][number],
      ): void => {
        if (!isToolUIPart(part)) return;
        if (part.providerExecuted) return;
        if (part.state !== 'input-available') return;
        if (dispatchedToolCallIds.has(part.toolCallId)) return;

        // Mark as dispatched before starting execution to prevent races
        dispatchedToolCallIds.add(part.toolCallId);

        const toolName = getToolName(part);
        this.deps.logger.info(
          { toolName, toolCallId: part.toolCallId, input: part.input },
          'Tool execution started',
        );

        const toolSpan = trace.getTracer('fluid-agent').startSpan(
          `tool.${toolName}`,
          {
            attributes: {
              'tool.name': toolName,
              'tool.callId': part.toolCallId,
              'tool.input': JSON.stringify(part.input),
            },
          },
          context.active(),
        );

        toolExecutions.push(
          executeTool(part, this.deps.tools, {
            toolCallId: part.toolCallId,
            messages: modelMessages,
            // biome-ignore lint/suspicious/noExplicitAny: executeTool util has incorrect context typing
            context: undefined as any,
            abortSignal: toolAbortController.signal,
          })
            .then(() => {
              // biome-ignore lint/suspicious/noExplicitAny: executeTool mutates part state in place, TS can't track it
              const p = part as any;
              toolSpan.setAttribute('tool.state', p.state);
              if (p.state === 'output-available' && p.output !== undefined) {
                toolSpan.setAttribute('tool.output', JSON.stringify(p.output));
              }
              toolSpan.end();
              this.deps.logger.info(
                {
                  toolName,
                  toolCallId: part.toolCallId,
                  input: p.input,
                  output: p.output,
                  state: p.state,
                },
                'Tool execution finished',
              );
            })
            .catch((error) => {
              toolSpan.setAttribute('tool.error', String(error));
              toolSpan.end();
              this.deps.logger.error(
                {
                  toolName,
                  toolCallId: part.toolCallId,
                  input: part.input,
                  error,
                },
                'Tool execution failed',
              );
            }),
        );
      };

      // 2.2.8: Run generation process
      let forceNextStep = false;

      try {
        const generationAbortController = new AbortController();
        this.generationAbortController = generationAbortController;

        const response = await runStreamedGeneration({
          model,
          modelMessages,
          tools: this.deps.tools,
          abortSignal: generationAbortController.signal,
          logger: this.deps.logger,
          getChatModelId: this.deps.getChatModelId,
          onUpdate: (msg) => {
            latestMessage = msg;
            for (const part of msg.parts) {
              dispatchToolCall(part);
            }
          },
        });
        latestMessage = response.message;
        this.stepSpan.addEvent('step.generation_finished', {
          'generation.finishReason': response.finishReason,
          'generation.usage.inputTokens': response.usage.inputTokens,
          'generation.usage.outputTokens': response.usage.outputTokens,
        });
        this.stepSpan.setAttribute('step.finishReason', response.finishReason);
        this.stepSpan.setAttribute(
          'step.toolCallCount',
          dispatchedToolCallIds.size,
        );

        if (
          response.finishReason === 'stop' ||
          response.finishReason === 'tool-calls'
        ) {
          this.deps.messages.push(response.message);
        } else {
          // Non-good finish reason — salvage whatever we can and force
          // the turn to run another step.
          if (repairPartialMessage(response.message)) {
            this.deps.messages.push(response.message);
            this.stepSpan.setAttribute('step.salvaged', true);
          } else {
            this.stepSpan.setAttribute('step.salvageFailed', true);
          }

          // If the model itself reported an error, classify it and
          // trigger model fallback when the error is model-related.
          if (response.finishReason === 'error') {
            const classification = classifyGenerationError(response.error);
            this.stepSpan.setAttribute(
              'step.errorClassification',
              classification.reason,
            );
            if (classification.isModelError) {
              this.deps.fallbackToNextModel();
              this.stepSpan.setAttribute('step.modelFallbackTriggered', true);
            }
          }

          forceNextStep = true;
        }
      } catch (e) {
        this.stepSpan.recordException(e as Error);
        this.stepSpan.setAttribute('step.error', String(e));
        this.deps.logger.error('Generation failed', e);

        // Salvage the partial message from streaming if possible.
        if (latestMessage && repairPartialMessage(latestMessage)) {
          this.deps.messages.push(latestMessage);
          this.stepSpan.setAttribute('step.salvaged', true);
        }

        // Classify the error and trigger model fallback if model-related.
        const classification = classifyGenerationError(e);
        this.stepSpan.setAttribute(
          'step.errorClassification',
          classification.reason,
        );
        if (classification.isModelError) {
          this.deps.fallbackToNextModel();
          this.stepSpan.setAttribute('step.modelFallbackTriggered', true);
        }

        forceNextStep = true;
      }

      // 2.2.9: Sweep the final message for any tool calls that were fully
      // streamed but not yet dispatched (e.g. due to abort mid-stream).
      // This ensures every tool call that reached 'input-available' state
      // is executed exactly once, regardless of whether generation completed
      // normally or was aborted.
      const preSweepCount = dispatchedToolCallIds.size;
      if (latestMessage) {
        for (const part of latestMessage.parts) {
          dispatchToolCall(part);
        }
      }
      const sweptToolCount = dispatchedToolCallIds.size - preSweepCount;
      if (sweptToolCount > 0) {
        this.stepSpan.addEvent('step.tools_swept', {
          'step.sweptToolCount': sweptToolCount,
        });
        this.deps.logger.info(
          { stepId: this.id, sweptToolCount },
          'Post-generation tool sweep dispatched additional tool calls',
        );
      }

      // Wait for all in-flight tool executions to finish before step ends.
      // This includes tools dispatched during streaming AND tools dispatched
      // in the post-generation sweep. Tools always run to completion even if
      // the generation was aborted (toolAbortController is never aborted).
      await Promise.all(toolExecutions);
      this.stepSpan.addEvent('step.tools_settled', {
        'step.toolCallCount': toolExecutions.length,
      });

      this.stepSpan.setAttribute('step.forceNextStep', forceNextStep);
      if (forceNextStep) {
        this.stepSpan.addEvent('step.force_continue', {});
      }

      this.deps.logger.trace('FINISH_STEP', { id: this.id, forceNextStep });
      this.stepSpan.end();
      return { hadGeneration: true, forceNextStep };
    });
  }

  abortGeneration(): void {
    this.generationAbortController?.abort();
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
    const modelId = this.deps.getChatModelId();
    return this.deps.modelProvider.get(modelId);
  }
}

export function createStep(deps: StepDependencies): Step {
  return new StepModule(deps);
}
