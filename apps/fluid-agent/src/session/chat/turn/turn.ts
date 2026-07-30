import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { Usage } from '@/session/types';

import type { ExtensionHandler } from '../extension-handler';
import { type SessionInboxBuffer, SessionInboxPriority } from '../inbox';
import type { ExtendedUIMessage } from '../message-types';
import { createStep, type Step, type StepCompleteEvent } from '../step';
import type { AgentTools } from '../tools';
import { inboxDrainAttributes } from '../utils/inbox-drain-attributes';
import type { ModelFallbackManager } from '../utils/model-fallback-manager';
import { tracer } from '../utils/tracing';
import { extractUsage } from '../utils/usage';

export interface TurnDependencies {
  logger: ModuleLogger;
  sessionId: string;
  sessionContext: Context;
  sessionSpan: Span;
  messages: ExtendedUIMessage[];
  inbox: SessionInboxBuffer;
  extensionHandler: ExtensionHandler;
  tools: AgentTools;
  modelProvider: ModelProvider;
  fallbackManager: ModelFallbackManager;
  config: Config;
  /**
   * When true, the turn injects a "Continue." user message before the
   * first step if the last message is not already a user message. Used by
   * the session's backoff retry to ensure generation is actually retried
   * even when the inbox is empty.
   */
  forceContinue?: boolean;
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
   * True if no step in the turn had a successful generation. The loop
   * should apply backoff before retrying (unless fatalError is also true,
   * in which case the session is terminated).
   */
  completeFailure: boolean;
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
          'session.id': this.deps.sessionId,
          'session.messageCount': this.deps.messages.length,
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

    try {
      await context.with(turnContext, async () => {
        // 2.1: Fetch inbox for low, medium and high prio inputs
        const drainedLow = this.deps.inbox.drain(
          this.deps.messages,
          SessionInboxPriority.Low,
          this.deps.logger,
        );
        turnSpan.addEvent(
          'turn.inbox_drained',
          inboxDrainAttributes(drainedLow, 'low'),
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
        };
        let stepCount = 0;
        const MAX_STEPS_PER_TURN = 20;

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

        while (stepResult.shouldContinue && stepCount < MAX_STEPS_PER_TURN) {
          if (needsContinue) {
            const lastMsg = this.deps.messages[this.deps.messages.length - 1];
            if (lastMsg?.role !== 'user') {
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
            inbox: this.deps.inbox,
            extensionHandler: this.deps.extensionHandler,
            tools: this.deps.tools,
            modelProvider: this.deps.modelProvider,
            fallbackManager: this.deps.fallbackManager,
            config: this.deps.config,
            turnInitialFallbackIndex,
            sessionId: this.deps.sessionId,
          });
          this.currentStep = step;

          try {
            stepResult = await step.run();
          } finally {
            this.currentStep = null;
          }
          stepCount++;
          totalStepCount = stepCount;
          if (stepResult.generation?.usage) {
            lastUsage = extractUsage(stepResult.generation.usage);
          }

          // Fatal error — stop the turn immediately.
          if (stepResult.fatalError) {
            fatalError = true;
            fatalErrorReason = stepResult.fatalErrorReason;
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
            !stepResult.modelFallbackOccurred
          ) {
            hadAnySuccess = true;
          }
          if (stepResult.generationFailed || stepResult.modelFallbackOccurred) {
            hadAnyFailure = true;
          }

          // If the step salvaged content, inject "Continue." before the next step.
          if (stepResult.forceNextStep) {
            needsContinue = true;
          }
        }

        if (stepCount >= MAX_STEPS_PER_TURN) {
          turnSpan.setAttribute('turn.stepCapReached', true);
          this.deps.logger.error(
            { turnId: this.id, stepCount },
            'Turn exceeded max steps — stopping to prevent infinite loop',
          );
        }

        turnSpan.setAttribute('turn.stepCount', stepCount);
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
      completeFailure: hadAnyFailure && !hadAnySuccess,
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
