import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import { type SessionInboxBuffer, SessionInboxPriority } from '@/session/inbox';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';

import type { ExtensionHandler } from '../extension-handler';
import { createStep, type Step, type StepResult } from '../step';
import { drainInbox } from '../utils/drain-inbox';

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
  getChatModelId: () => ModelId;
  getModelFallbackIndex: () => number;
  fallbackToNextModel: () => void;
}

export interface Turn {
  run(): Promise<void>;
  abortGeneration(): void;
}

class TurnModule implements Turn {
  private readonly id = randomUUID();

  private readonly turnSpan: Span;

  private readonly turnContext: Context;

  private currentStep: Step | null = null;

  constructor(private readonly deps: TurnDependencies) {
    this.turnSpan = trace.getTracer('fluid-agent').startSpan(
      'turn',
      {
        attributes: {
          'turn.id': this.id,
          'session.id': deps.sessionId,
          'session.messageCount': deps.messages.length,
        },
      },
      deps.sessionContext,
    );
    this.turnContext = trace.setSpan(deps.sessionContext, this.turnSpan);

    deps.sessionSpan.addEvent('session.turn_started', { 'turn.id': this.id });
    deps.logger.trace('START_TURN', { id: this.id });
  }

  async run(): Promise<void> {
    await context.with(this.turnContext, async () => {
      // 2.1: Fetch inbox for low, medium and high prio inputs
      const drainedLow = drainInbox(
        this.deps.inbox,
        this.deps.messages,
        SessionInboxPriority.Low,
        this.deps.logger,
      );
      this.turnSpan.addEvent('turn.inbox_drained', {
        'inbox.minPriority': 'low',
        'inbox.total': drainedLow.total,
        'inbox.low': drainedLow.byPriority.low,
        'inbox.medium': drainedLow.byPriority.medium,
        'inbox.high': drainedLow.byPriority.high,
      });

      // 2.2: Run steps until no more generation is needed
      let stepResult: StepResult = {
        hadGeneration: true,
        forceNextStep: false,
      };
      let stepCount = 0;

      while (stepResult.hadGeneration) {
        // If the previous step forced a next step, inject a "Continue."
        // user message so that the next step's canStepBeExecuted() returns
        // true even if the last message is an assistant message without
        // tool calls (e.g. after a truncated generation).
        if (stepResult.forceNextStep) {
          const lastMsg = this.deps.messages[this.deps.messages.length - 1];
          if (lastMsg?.role !== 'user') {
            this.deps.messages.push({
              id: randomUUID(),
              role: 'user',
              parts: [{ type: 'text', text: 'Continue.' }],
            });
            this.turnSpan.addEvent('turn.force_continue_injected', {});
            this.deps.logger.info(
              { turnId: this.id, stepCount },
              'Forced continue message injected',
            );
          }
        }

        const step = createStep({
          logger: this.deps.logger,
          turnContext: this.turnContext,
          messages: this.deps.messages,
          inbox: this.deps.inbox,
          extensionHandler: this.deps.extensionHandler,
          tools: this.deps.tools,
          modelProvider: this.deps.modelProvider,
          getChatModelId: this.deps.getChatModelId,
          getModelFallbackIndex: this.deps.getModelFallbackIndex,
          fallbackToNextModel: this.deps.fallbackToNextModel,
        });
        this.currentStep = step;

        try {
          stepResult = await step.run();
        } finally {
          this.currentStep = null;
        }
        stepCount++;
      }

      this.turnSpan.setAttribute('turn.stepCount', stepCount);
      this.turnSpan.addEvent('turn.complete', {
        'turn.id': this.id,
        'turn.steps': stepCount,
      });
      this.deps.sessionSpan.addEvent('session.turn_completed', {
        'turn.id': this.id,
        'turn.steps': stepCount,
      });
      this.deps.logger.trace('FINISH_TURN', { id: this.id });
      this.turnSpan.end();
    });
  }

  abortGeneration(): void {
    this.currentStep?.abortGeneration();
  }
}

export function createTurn(deps: TurnDependencies): Turn {
  return new TurnModule(deps);
}
