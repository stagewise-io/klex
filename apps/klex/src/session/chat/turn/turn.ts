import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';
import { isToolUIPart } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { ProviderModelResolver } from '@/provider-registry';
import type { Usage } from '@/session/types';
import type { TelemetryMetrics } from '@/telemetry-metrics';

import type { ExtensionHandler } from '../extension-handler';
import type { SessionInboxBuffer } from '../inbox';
import type { ExtendedUIMessage } from '../message-types';
import { createStep, type Step, type StepCompleteEvent } from '../step';
import { inboxDrainAttributes } from '../utils/inbox-drain-attributes';
import type { ModelFallbackManager } from '../utils/model-fallback-manager';
import { tracer } from '../utils/tracing';
import { extractUsage } from '../utils/usage';

/**
 * Hard upper bound on steps per turn. Exists purely to guarantee that a
 * turn terminates, even for pathological tool loops or step results that
 * keep requesting continuation. Generous enough for long tool chains.
 */
export const MAX_STEPS_PER_TURN = 200;

/** Why a turn's step loop ended. Exposed for observability. */
export type TurnStopReason =
  | 'completed'
  | 'failure_budget_exhausted'
  | 'step_cap_reached'
  | 'yielded'
  | 'fatal';

export interface TurnDependencies {
  logger: ModuleLogger;
  sessionId: string;
  telemetryMetrics?: TelemetryMetrics;
  sessionContext: Context;
  sessionSpan: Span;
  messages: ExtendedUIMessage[];
  inbox: SessionInboxBuffer;
  extensionHandler: ExtensionHandler;
  modelResolver: ProviderModelResolver;
  fallbackManager: ModelFallbackManager;
  config: Config;
  /**
   * When true, the turn injects a "Continue." user message before the
   * first step if the last message is not already a user message. Used by
   * the session's backoff retry to ensure generation is actually retried
   * even when the inbox is empty.
   */
  forceContinue?: boolean;
  /**
   * When true, the turn injects a `data-check` user message before the
   * first step if the last message is an assistant message without tool
   * calls. Used by the session's check-retry to prompt the model to
   * review new input that arrived during the previous turn.
   */
  forceCheck?: boolean;
  /**
   * Called after each step commits its response to messages[]. Flushes
   * any immediate (Critical/Default) events that were queued during the
   * step's generation, preserving response-before-new-input ordering.
   */
  flushPendingImmediate?: () => void;
  /** Stops the turn after the current step reaches its commit boundary. */
  shouldYieldGenerationLane?: () => boolean;
  /**
   * Base system prompt forwarded to each step.
   */
  basePrompt: string;
}

export interface TurnResult {
  /**
   * True if the turn ended because every step failed with a fatal
   * (non-recoverable) error. The session should be terminated.
   */
  fatalError: boolean;
  /** Human-readable reason for the fatal error, if fatalError is true. */
  fatalErrorReason: string | null;
  /**
   * True if the turn did not finish: either no step had a successful
   * generation, or the turn ended on a failed step (e.g. the failure
   * budget ran out after earlier steps succeeded). The loop should apply
   * backoff before retrying (unless fatalError is also true, in which
   * case the session is terminated).
   */
  completeFailure: boolean;
  /**
   * True if the last failing step of the turn was a provider request
   * rejection (4xx). Retrying the same request will not help, so the
   * session must not apply backoff retries for this turn.
   */
  requestRejected: boolean;
  /** Why the step loop ended. */
  stopReason: TurnStopReason;
  /** Total number of steps executed in this turn. */
  stepCount: number;
  /** Token usage from the last successful generation in this turn, if any. */
  usage: Usage | null;
}

export interface Turn {
  run(): Promise<TurnResult>;
  abortGeneration(reason?: string): void;
  /** Abort all in-flight tool executions. Use during session shutdown. */
  abortTools(): void;
}

class TurnModule implements Turn {
  private readonly id = randomUUID();

  private turnSpan: Span | null = null;

  private currentStep: Step | null = null;

  constructor(private readonly deps: TurnDependencies) {}

  async run(): Promise<TurnResult> {
    // Lazy span creation: spans are created at run() time to prevent
    // span leaks if run() is never called.
    const turnSpan = tracer.startSpan(
      'turn',
      {
        attributes: {
          'turn.id': this.id,
          'klex.session.id': this.deps.sessionId,
          'klex.session.message_count': this.deps.messages.length,
        },
      },
      this.deps.sessionContext,
    );
    this.turnSpan = turnSpan;
    const turnContext = trace.setSpan(this.deps.sessionContext, turnSpan);

    this.deps.sessionSpan.addEvent('session.turn_started', {
      'turn.id': this.id,
    });
    this.deps.logger.info({ turnId: this.id }, 'Turn started');

    let fatalError = false;
    let fatalErrorReason: string | null = null;
    let hadAnySuccess = false;
    let hadAnyFailure = false;
    let lastUsage: Usage | null = null;
    let totalStepCount = 0;
    let lastFailureWasRejection = false;
    let lastStepFailed = false;
    let stopReason: TurnStopReason = 'completed';

    try {
      await context.with(turnContext, async () => {
        // 2.1: Drain deferred inbox inputs (Deferrable urgency only).
        // Critical and Default urgency items were already appended to
        // messages[] immediately on arrival.
        const drainedDeferred = this.deps.inbox.drain(
          this.deps.messages,
          this.deps.logger,
        );
        turnSpan.addEvent(
          'turn.inbox_drained',
          inboxDrainAttributes(drainedDeferred, 'turn'),
        );

        // 2.2: Run steps until no more generation is needed
        let stepResult: StepCompleteEvent = {
          shouldContinue: true,
          forceNextStep: false,
          fatalError: false,
          fatalErrorReason: null,
          generationFailed: false,
          generation: null,
          toolCalls: [],
          modelFallbackOccurred: false,
          requestRejected: false,
        };
        let stepCount = 0;

        // Consecutive failed-step budget: one full rotation through all
        // configured models plus one retry with degraded content (after a
        // request rejection, extensions drop injected content).
        const failureBudget =
          Math.max(1, this.deps.fallbackManager.getChatModelCount()) + 1;
        let consecutiveFailedSteps = 0;
        let rejectedSteps = 0;

        // Capture the fallback index at the start of the turn for
        // turn-level wrap-around detection. Model fallback now spans
        // multiple steps, so wrap-around must be relative to this index.
        const turnInitialFallbackIndex =
          this.deps.fallbackManager.getFallbackIndex();

        // Unified "Continue." injection: a single needsContinue flag is
        // set by either the session's backoff retry (forceContinue) or
        // by a step's forceNextStep result (salvage). Both produce the
        // same action — inject a "Continue." user message before the
        // next step.
        let needsContinue = this.deps.forceContinue ?? false;
        let needsCheck = this.deps.forceCheck ?? false;

        while (stepResult.shouldContinue) {
          if (stepCount >= MAX_STEPS_PER_TURN) {
            stopReason = 'step_cap_reached';
            turnSpan.addEvent('turn.step_cap_reached', {
              'turn.steps': stepCount,
              'turn.maxSteps': MAX_STEPS_PER_TURN,
            });
            this.deps.logger.error(
              { turnId: this.id, stepCount },
              'Turn stopped: step cap reached',
            );
            break;
          }
          // Check injection (before continue injection — a check-retry
          // turn needs the prompt before the first step). The check
          // message tells the model to review new input and decide
          // whether to do more. Only injected once (consumed on first
          // iteration), same guard as Continue: only when the last
          // message is an assistant without tool calls.
          if (needsCheck) {
            const lastMsg = this.deps.messages[this.deps.messages.length - 1];
            const shouldInjectCheck =
              lastMsg?.role === 'assistant' &&
              !lastMsg.parts.some((p) => isToolUIPart(p));
            if (shouldInjectCheck) {
              this.deps.messages.push({
                id: randomUUID(),
                role: 'user',
                parts: [{ type: 'data-check', data: {} }],
              });
              turnSpan.addEvent('turn.force_check_injected', {});
              this.deps.logger.debug(
                { turnId: this.id, stepCount },
                'Forced check message injected',
              );
            }
            needsCheck = false;
          }

          if (needsContinue) {
            // Continue is only useful when the last message is an assistant
            // message without tool calls — the model needs an explicit prompt
            // to continue a text-only response. If the last message is a user
            // message, an assistant with tool calls (tool results prompt
            // continuation naturally), or anything else, Continue is redundant.
            const lastMsg = this.deps.messages[this.deps.messages.length - 1];
            const shouldInject =
              lastMsg?.role === 'assistant' &&
              !lastMsg.parts.some((p) => isToolUIPart(p));
            if (shouldInject) {
              this.deps.messages.push({
                id: randomUUID(),
                role: 'user',
                parts: [{ type: 'data-continue', data: {} }],
              });
              turnSpan.addEvent('turn.force_continue_injected', {});
              this.deps.logger.debug(
                { turnId: this.id, stepCount },
                'Forced continue message injected',
              );
            }
            needsContinue = false;
          }

          const step = createStep({
            logger: this.deps.logger,
            turnContext,
            messages: this.deps.messages,
            extensionHandler: this.deps.extensionHandler,
            modelResolver: this.deps.modelResolver,
            fallbackManager: this.deps.fallbackManager,
            config: this.deps.config,
            turnInitialFallbackIndex,
            sessionId: this.deps.sessionId,
            telemetryMetrics: this.deps.telemetryMetrics,
            basePrompt: this.deps.basePrompt,
          });
          this.currentStep = step;

          try {
            stepResult = await step.run();
          } finally {
            this.currentStep = null;
          }

          // Flush any immediate events that were queued during the
          // step's generation. This ensures new input appears after
          // the assistant response, preserving correct ordering.
          this.deps.flushPendingImmediate?.();

          stepCount++;
          totalStepCount = stepCount;

          if (stepResult.generation?.usage) {
            lastUsage = extractUsage(stepResult.generation.usage);
          }
          if (this.deps.shouldYieldGenerationLane?.()) {
            stopReason = 'yielded';
            turnSpan.addEvent('turn.generation_lane_yielded');
            break;
          }

          // Fatal error — stop the turn immediately.
          if (stepResult.fatalError) {
            fatalError = true;
            fatalErrorReason = stepResult.fatalErrorReason;
            stopReason = 'fatal';
            this.deps.logger.error(
              { turnId: this.id, stepCount, reason: fatalErrorReason },
              'Turn aborted due to fatal step error',
            );
            break;
          }

          // Track whether any step succeeded or failed.
          if (
            stepResult.shouldContinue &&
            !stepResult.forceNextStep &&
            !stepResult.modelFallbackOccurred &&
            !stepResult.generationFailed &&
            !stepResult.requestRejected
          ) {
            hadAnySuccess = true;
          }
          const stepFailed =
            stepResult.generationFailed ||
            stepResult.modelFallbackOccurred ||
            stepResult.requestRejected;
          lastStepFailed = stepFailed;
          if (stepFailed) {
            hadAnyFailure = true;
            consecutiveFailedSteps++;
            lastFailureWasRejection = stepResult.requestRejected;
          } else {
            // A clean step resets both counters, so a later first
            // rejection again retries on the same model with degraded
            // content before falling back.
            consecutiveFailedSteps = 0;
            rejectedSteps = 0;
          }

          if (stepFailed && consecutiveFailedSteps >= failureBudget) {
            stopReason = 'failure_budget_exhausted';
            turnSpan.addEvent('turn.failure_budget_exhausted', {
              'turn.steps': stepCount,
              'turn.consecutiveFailedSteps': consecutiveFailedSteps,
              'turn.failureBudget': failureBudget,
              'turn.rejectedSteps':
                rejectedSteps + (stepResult.requestRejected ? 1 : 0),
            });
            this.deps.logger.error(
              {
                turnId: this.id,
                stepCount,
                consecutiveFailedSteps,
                failureBudget,
                requestRejected: stepResult.requestRejected,
              },
              'Turn stopped: consecutive step failure budget exhausted',
            );
            break;
          }

          // Request rejected: the first rejection is retried on the same
          // model (extensions degrade injected content in onStepComplete).
          // Further rejections fall back so a bad model ID still reaches
          // the configured backup models.
          if (stepResult.requestRejected) {
            rejectedSteps++;
            if (rejectedSteps >= 2) {
              this.deps.fallbackManager.fallbackToNextModel();
              turnSpan.addEvent('turn.request_rejected_fallback', {
                'turn.rejectedSteps': rejectedSteps,
              });
            }
          }

          // If the step salvaged content, inject "Continue." before the next step.
          if (stepResult.forceNextStep) {
            needsContinue = true;
          }
        }

        turnSpan.setAttribute('turn.stepCount', stepCount);
        turnSpan.setAttribute('turn.stopReason', stopReason);
        turnSpan.addEvent('turn.complete', {
          'turn.id': this.id,
          'turn.steps': stepCount,
        });
        this.deps.sessionSpan.addEvent('session.turn_completed', {
          'turn.id': this.id,
          'turn.steps': stepCount,
        });
        this.deps.logger.info({ turnId: this.id, stepCount }, 'Turn finished');
      });
    } finally {
      this.turnSpan?.end();
    }

    return {
      fatalError,
      fatalErrorReason,
      completeFailure: hadAnyFailure && (!hadAnySuccess || lastStepFailed),
      requestRejected: lastFailureWasRejection,
      stopReason,
      stepCount: totalStepCount,
      usage: lastUsage,
    };
  }

  abortGeneration(reason?: string): void {
    this.currentStep?.abortGeneration(reason);
  }

  abortTools(): void {
    this.currentStep?.abortTools();
  }
}

export function createTurn(deps: TurnDependencies): Turn {
  return new TurnModule(deps);
}
