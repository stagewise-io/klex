import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { AgentTools } from '@/session/tools';
import {
  createJavaScriptTool,
  type JavaScriptTool,
} from '@/session/tools/javascript';
import { getMemoryTools } from '@/session/tools/memory';
import type {
  AgentSession,
  ExtendedUIMessage,
  SessionHooks,
  SessionStatus,
} from '@/session/types';
import type { ToolProvider } from '@/tool-provider';

import {
  createInbox,
  type SessionInbox,
  type SessionInboxBuffer,
  SessionInboxPriority,
} from '../inbox';
import {
  createExtensionHandler,
  type ExtensionHandler,
} from './extension-handler';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';
import { createTurn, type Turn, type TurnResult } from './turn';
import { BackoffManager } from './utils/backoff-manager';
import { ModelFallbackManager } from './utils/model-fallback-manager';
import { tracer } from './utils/tracing';

export interface ChatSessionDependencies {
  logging: RootLogger;
  modelProvider: ModelProvider;
  config: Config;
  toolProvider: ToolProvider;
  extensionFactories: ExtensionFactory[];
  hooks?: SessionHooks;
}

class ChatSessionModule implements AgentSession {
  private messages: ExtendedUIMessage[] = [];

  private readonly sessionInbox: SessionInboxBuffer;

  private readonly extensionHandler: ExtensionHandler;

  private fallbackManager: ModelFallbackManager;

  private backoffManager: BackoffManager;

  private loopActive = false;

  private currentTurn: Turn | null = null;

  private _status: SessionStatus = 'active';

  /**
   * Resolves when new inbox input arrives during a backoff wait.
   * Set to null when no wait is in progress.
   */
  private backoffInterrupt: (() => void) | null = null;

  private readonly sessionId = randomUUID();

  private readonly sessionSpan: Span;

  private readonly sessionContext: Context;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      logging: RootLogger;
      modelProvider: ModelProvider;
      config: Config;
      javaScriptTool: JavaScriptTool;
      tools: AgentTools;
      extensionFactories: ExtensionFactory[];
      hooks?: SessionHooks;
    },
  ) {
    // Create a session-level span that lives for the entire session lifetime.
    // All turn / step / generation spans inherit this trace, giving a single
    // trace tree per session in the tracing backend. The span stays open until
    // close() is called — child spans (turns, steps) are exported as they end,
    // so the trace is visible in real time even while the session span is open.
    this.sessionSpan = tracer.startSpan('session', {
      attributes: {
        'session.id': this.sessionId,
        'session.createdAt': new Date().toISOString(),
      },
    });
    this.sessionContext = trace.setSpan(context.active(), this.sessionSpan);

    this.fallbackManager = new ModelFallbackManager({
      logger: this.deps.logger,
      span: this.sessionSpan,
      sessionId: this.sessionId,
      getChatModels: () => this.deps.config.get().modelSelection.chat,
    });

    this.backoffManager = new BackoffManager({
      logger: this.deps.logger,
      span: this.sessionSpan,
      sessionId: this.sessionId,
    });

    const spanCtx = this.sessionSpan.spanContext();
    this.deps.logger.info(
      {
        sessionId: this.sessionId,
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
      },
      'Session started — trace available in tracing backend',
    );

    this.sessionInbox = createInbox({
      onNewEvent: this.onNewInboxEvent,
    });

    // Create the extension deps — functions that let extensions interoperate
    // with this session asynchronously.
    const extensionDeps: ExtensionDeps = {
      getHistory: () => [...this.messages],
      inbox: this.sessionInbox,
    };

    this.extensionHandler = createExtensionHandler({
      factories: deps.extensionFactories,
      extensionDeps,
    });
  }

  async start(): Promise<void> {
    await this.deps.javaScriptTool.start();
    this.deps.logger.info('ChatSession started');
  }

  // ---------------------------------------------------------------------------
  // Loop — hosted in the session per architecture.md
  // ---------------------------------------------------------------------------

  private onNewInboxEvent = (priority: SessionInboxPriority): void => {
    // High priority: abort the current generation immediately (2.2.8.2).
    if (priority === SessionInboxPriority.High && this.currentTurn) {
      this.currentTurn.abortGeneration('inbox_interrupt');
      this.sessionSpan.addEvent('session.generation_aborted', {
        'session.abortReason': 'inbox_interrupt',
        'inbox.priority': SessionInboxPriority[priority],
      });
    }

    // If currently in a backoff wait, interrupt it so the new input is
    // processed immediately.
    if (this.backoffInterrupt) {
      this.backoffInterrupt();
    }

    // If no turn is active, start one (architecture step 1).
    if (!this.loopActive) {
      void this.runLoop();
    }
  };

  /**
   * The main turn loop. Creates a Turn module per iteration so that the
   * Turn's lifetime (and its span) covers exactly one turn.
   *
   * Flow:
   * 1. Process inbox until empty.
   * 2. If a turn fails completely (all models exhausted) and the inbox
   *    is still empty, apply exponential backoff before retrying.
   * 3. If a turn fails with a fatal error (bad request), terminate the
   *    session immediately.
   * 4. New inbox input during a backoff wait interrupts the wait and
   *    resumes processing immediately.
   */
  private async runLoop(): Promise<void> {
    if (this.loopActive) return;
    this.loopActive = true;

    let needsBackoffRetry = false;

    while (true) {
      // If the inbox is empty AND we're not in a backoff retry cycle,
      // go idle.
      if (this.sessionInbox.isEmpty() && !needsBackoffRetry) {
        this.loopActive = false;
        this.sessionSpan.addEvent('session.idle', {
          'session.id': this.sessionId,
        });
        this.deps.logger.info(
          { sessionId: this.sessionId },
          'Session idle — inbox empty',
        );
        return;
      }

      // Run exactly one turn per iteration. The turn drains inbox input
      // and runs steps until no more generation is needed.
      //
      // If we're in a backoff retry cycle, the turn will run even though
      // the inbox may be empty — it retries generation with the existing
      // messages. The turn's step will find the last assistant message
      // (or a "Continue." message from the prior forceNextStep) and retry.
      const turn = createTurn({
        logger: this.deps.logger,
        sessionId: this.sessionId,
        sessionContext: this.sessionContext,
        sessionSpan: this.sessionSpan,
        messages: this.messages,
        inbox: this.sessionInbox,
        extensionHandler: this.extensionHandler,
        tools: this.deps.tools,
        modelProvider: this.deps.modelProvider,
        fallbackManager: this.fallbackManager,
        forceContinue: needsBackoffRetry,
      });
      this.currentTurn = turn;

      let turnResult: TurnResult;
      try {
        turnResult = await turn.run();
      } finally {
        this.currentTurn = null;
      }

      // Fatal error — terminate the session.
      if (turnResult.fatalError) {
        this.deps.logger.error(
          { sessionId: this.sessionId },
          'Fatal turn error — terminating session',
        );
        this.sessionSpan.addEvent('session.fatal_error', {
          'session.id': this.sessionId,
        });
        this.sessionSpan.setAttribute('session.terminated', true);
        this.loopActive = false;
        await this.terminate(turnResult.fatalErrorReason ?? 'unknown');
        return;
      }

      // Track success/failure for backoff.
      if (turnResult.completeFailure) {
        this.backoffManager.recordFailure();
        needsBackoffRetry = true;
      } else {
        this.backoffManager.recordSuccess();
        needsBackoffRetry = false;
      }

      // If the turn succeeded or was a no-op, loop back to the top
      // to check for more inbox input or go idle.
      if (!needsBackoffRetry) {
        continue;
      }

      // Turn failed completely — apply backoff before next iteration.
      const delay = this.backoffManager.getDelay();

      if (delay === 0) {
        // Immediate retry (within the configured immediate-retry budget).
        this.deps.logger.warn(
          {
            sessionId: this.sessionId,
            consecutiveFailures: this.backoffManager.getConsecutiveFailures(),
          },
          'All models failed — retrying immediately (within immediate retry budget)',
        );
        this.sessionSpan.addEvent('session.backoff_immediate_retry', {
          'session.consecutiveFailures':
            this.backoffManager.getConsecutiveFailures(),
        });
        continue;
      }

      this.deps.logger.warn(
        {
          sessionId: this.sessionId,
          consecutiveFailures: this.backoffManager.getConsecutiveFailures(),
          delayMs: delay,
        },
        'All models failed — waiting before retry (exponential backoff)',
      );
      this.sessionSpan.addEvent('session.backoff_wait', {
        'session.consecutiveFailures':
          this.backoffManager.getConsecutiveFailures(),
        'session.backoffDelayMs': delay,
      });

      // Wait for the delay, interruptible by new inbox input.
      const interrupted = await this.waitForBackoff(delay);
      if (interrupted) {
        this.deps.logger.debug(
          { sessionId: this.sessionId },
          'Backoff wait interrupted by new inbox input',
        );
        this.sessionSpan.addEvent('session.backoff_interrupted', {});
      }
    }
  }

  /**
   * Waits for the specified delay, interruptible by new inbox input.
   * Returns true if the wait was interrupted, false if it completed.
   */
  private async waitForBackoff(delayMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const interrupt = () => {
        clearTimeout(timer);
        this.backoffInterrupt = null;
        resolve(true);
      };
      this.backoffInterrupt = interrupt;
      timer = setTimeout(() => {
        this.backoffInterrupt = null;
        resolve(false);
      }, delayMs);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public get inbox(): SessionInbox {
    return this.sessionInbox;
  }

  public get status(): SessionStatus {
    return this._status;
  }

  async close(): Promise<void> {
    this._status = 'terminated';

    // Close the inbox first — no new input can enter the session after
    // this point. Any concurrent send() calls will throw
    // SessionInboxClosedError.
    this.sessionInbox.close();

    await this.deps.javaScriptTool.close();
    this.sessionSpan.addEvent('session.closed', {
      'session.id': this.sessionId,
      'session.messageCount': this.messages.length,
    });
    this.sessionSpan.setAttribute('session.closedAt', new Date().toISOString());
    this.sessionSpan.end();
    this.deps.logger.info(
      { sessionId: this.sessionId },
      'Session closed — session span ended',
    );
  }

  /**
   * Self-termination path (fatal error). Closes the session and fires the
   * `onTerminated` hook so the router can react immediately — replace the
   * session, preserve history, log, etc.
   *
   * Unlike `close()`, this is only called when the session decides it is
   * unrecoverable, not during router-initiated graceful shutdown.
   */
  private async terminate(reason: string): Promise<void> {
    // Close the inbox first — this blocks any new events from arriving
    // while we drain what's already buffered.
    this.sessionInbox.close();

    // Drain remaining inbox content so the router can re-dispatch it
    // to the replacement session. getEvents/getMessages(Low) drains all
    // priorities. These methods are safe to call after close().
    const pendingEvents = this.sessionInbox.getEvents(SessionInboxPriority.Low);
    const pendingMessages = this.sessionInbox.getMessages(
      SessionInboxPriority.Low,
    );

    // Now perform the standard close (span end, status update, etc.).
    // close() will call sessionInbox.close() again — that's a no-op.
    await this.close();

    this.deps.logger.info(
      {
        sessionId: this.sessionId,
        pendingEvents: pendingEvents.length,
        pendingMessages: pendingMessages.length,
      },
      'Session self-terminated — firing onTerminated hook',
    );

    this.deps.hooks?.onTerminated?.({
      sessionId: this.sessionId,
      reason,
      finalMessages: [...this.messages],
      pendingEvents,
      pendingMessages,
    });
  }
}

export function createChatSession(deps: ChatSessionDependencies): AgentSession {
  const javaScriptTool = createJavaScriptTool({
    logging: deps.logging,
    provider: deps.toolProvider,
  });
  return new ChatSessionModule({
    logger: deps.logging.child({
      name: 'chat-session',
      bindings: { module: 'chat-session' },
    }),
    logging: deps.logging,
    modelProvider: deps.modelProvider,
    config: deps.config,
    javaScriptTool,
    tools: {
      ...getMemoryTools(),
      ...javaScriptTool.tools,
    },
    extensionFactories: deps.extensionFactories,
    hooks: deps.hooks,
  });
}
