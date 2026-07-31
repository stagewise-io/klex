import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';
import { generateText } from 'ai';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config, ModelId } from '@/config';
import type { Mcp } from '@/mcp';
import type { ModelProvider } from '@/model-provider';
import type { SessionInboxEvent } from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionInfo,
  SessionRuntimeState,
  SessionStatus,
  Usage,
  UsagePair,
} from '@/session/types';

import {
  createExtensionHandler,
  type ExtensionHandler,
} from './extension-handler';
import type {
  BaseExtensionDeps,
  ExtensionFactory,
  GenerateTextArgs,
  GenerateTextResult,
} from './extensions/extension-api';
import {
  createInbox,
  type SessionInbox,
  type SessionInboxBuffer,
  SessionInboxPriority,
} from './inbox';
import type { ExtendedUIMessage } from './message-types';
import type { AgentTools } from './tools';
import { createTurn, type Turn, type TurnResult } from './turn';
import { BackoffManager } from './utils/backoff-manager';
import { ModelFallbackManager } from './utils/model-fallback-manager';
import { getExtensionIdentifier, tracer } from './utils/tracing';
import { extractUsage } from './utils/usage';

/**
 * Maximum consecutive complete-failure turns before the session terminates.
 * Prevents infinite retry loops when all models are unavailable.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

export interface ChatSessionDependencies {
  logging: RootLogger;
  modelProvider: ModelProvider;
  config: Config;
  mcp: Mcp;
  extensionFactories: ExtensionFactory[];
  /** Root data directory of the agent. Used for extension data dirs. */
  dataDirectory: string;
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

  /** Prevents double-close (terminate() + router close()). */
  private closePromise: Promise<void> | null = null;

  /**
   * Resolves when new inbox input arrives during a backoff wait.
   * Set to null when no wait is in progress.
   */
  private backoffInterrupt: (() => void) | null = null;

  private readonly sessionId = randomUUID();

  private readonly sessionSpan: Span;

  private readonly sessionContext: Context;

  // --- Observability tracking ---

  private runtimeState: SessionRuntimeState = 'idle';

  private turnCount = 0;

  private stepCount = 0;

  // --- Chat usage tracking ---

  private latestChatUsage: Usage | null = null;

  private totalChatUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    inputCacheWriteTokens: 0,
    inputCacheReadTokens: 0,
  };

  // --- Per-extension usage tracking ---

  private extensionUsage: Map<string, UsagePair> = new Map();

  private readonly createdAt: string;

  private readonly tools: AgentTools;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      logging: RootLogger;
      modelProvider: ModelProvider;
      config: Config;
      dataDirectory: string;
      mcp: Mcp;
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
    this.createdAt = new Date().toISOString();

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
      logger: this.deps.logger,
    });

    // Create the extension deps — functions that let extensions interoperate
    // with this session asynchronously. getDataDir is injected per-extension
    // by the ExtensionHandler, not here.
    const extensionDeps: BaseExtensionDeps = {
      getHistory: () => [...this.messages],
      insertMessageAfter: (afterMessageId, message) => {
        // Reject inserts once the session is terminated so an
        // outstanding extension task (e.g. compaction) can't mutate
        // the final history of a closed session.
        if (this._status === 'terminated') return false;
        const index = this.messages.findIndex((m) => m.id === afterMessageId);
        if (index === -1) return false;
        this.messages.splice(index + 1, 0, message);
        return true;
      },
      inbox: this.sessionInbox,
      config: this.deps.config,
      generateText: (args) => this.generateTextForExtension(args),
      logger: this.deps.logger,
      logging: this.deps.logging,
      mcp: this.deps.mcp,
      sessionId: this.sessionId,
    };

    this.extensionHandler = createExtensionHandler({
      factories: deps.extensionFactories,
      extensionDeps,
      dataDirectory: this.deps.dataDirectory,
      sessionId: this.sessionId,
      onExtensionUsage: (identifier, usage) => {
        const existing = this.extensionUsage.get(identifier);
        if (existing) {
          existing.latest = usage;
          existing.total = {
            inputTokens: existing.total.inputTokens + usage.inputTokens,
            outputTokens: existing.total.outputTokens + usage.outputTokens,
            inputCacheWriteTokens:
              existing.total.inputCacheWriteTokens +
              usage.inputCacheWriteTokens,
            inputCacheReadTokens:
              existing.total.inputCacheReadTokens + usage.inputCacheReadTokens,
          };
        } else {
          this.extensionUsage.set(identifier, {
            latest: usage,
            total: { ...usage },
          });
        }
      },
    });

    // All tools are provided by extensions.
    this.tools = this.extensionHandler.getTools() as AgentTools;
  }

  async start(): Promise<void> {
    await this.extensionHandler.start();
    this.deps.logger.info('ChatSession started');
  }

  // ---------------------------------------------------------------------------
  // Extension AI proxy — routes generation calls through the session so
  // that AI usage can be tracked at the session level.
  // ---------------------------------------------------------------------------

  private async generateTextForExtension(
    args: GenerateTextArgs,
  ): Promise<GenerateTextResult> {
    const { modelIds } = args;

    // Read the extension identifier from the OTel context. The extension
    // handler wrapper sets it before calling this method so that the trace
    // span's gen_ai.agent.name is attributed as "extension:{identifier}".
    const extensionIdentifier = getExtensionIdentifier();
    const functionId = extensionIdentifier
      ? `extension:${extensionIdentifier}`
      : 'extension';

    // Start a child span under the session span so every extension-initiated
    // generation appears in the session trace tree. The AI SDK's own internal
    // telemetry spans also nest under this span because we run the call inside
    // a context.with block with the session context as parent.
    const span = tracer.startSpan(
      'generate_content',
      {
        attributes: {
          'gen.extension': true,
          'gen.modelIds': modelIds.join(','),
          'gen.modelCount': modelIds.length,
          'gen.systemProvided': args.system != null,
          'gen.promptProvided': args.prompt != null,
          'gen.messagesProvided': args.messages != null,
          'gen.messageCount': args.messages?.length ?? 0,
          'gen.promptLength': args.prompt?.length ?? 0,
          'gen.toolsProvided': args.tools != null,
          'gen.toolNames': args.tools ? Object.keys(args.tools).join(',') : '',
          'gen.temperature': args.temperature,
          'gen.maxOutputTokens': args.maxOutputTokens,
          'gen.maxRetries': args.maxRetries ?? 0,
        },
      },
      this.sessionContext,
    );

    try {
      return await context.with(this.sessionContext, async () => {
        if (modelIds.length === 0) {
          span.addEvent('gen.no_models');
          span.setAttribute('gen.outcome', 'no-models');
          return {
            success: false as const,
            failureReason: 'no-models' as const,
          };
        }

        const failures: string[] = [];
        let contentFilterCount = 0;

        for (const modelId of modelIds) {
          try {
            const model = await this.deps.modelProvider.get(modelId);
            const result = await generateText(
              args.messages
                ? {
                    model,
                    system: args.system,
                    messages: args.messages,
                    tools: args.tools,
                    temperature: args.temperature,
                    maxOutputTokens: args.maxOutputTokens,
                    maxRetries: args.maxRetries ?? 0,
                    telemetry: { isEnabled: true, functionId },
                    runtimeContext: {
                      'conversation.modelId': modelId,
                    },
                  }
                : {
                    model,
                    system: args.system,
                    prompt: args.prompt ?? '',
                    tools: args.tools,
                    temperature: args.temperature,
                    maxOutputTokens: args.maxOutputTokens,
                    maxRetries: args.maxRetries ?? 0,
                    telemetry: { isEnabled: true, functionId },
                    runtimeContext: {
                      'conversation.modelId': modelId,
                    },
                  },
            );

            // Per-extension usage tracking is handled by the
            // onExtensionUsage callback in the extension handler wrapper.

            // The AI SDK does not throw for content-filter responses —
            // it returns a result with finishReason: 'content-filter' and
            // the refusal text as result.text. Intercept this so the
            // extension sees a structured failure instead of a fake
            // success with useless refusal text.
            if (result.finishReason === 'content-filter') {
              const msg = `${modelId}: content-filter response`;
              failures.push(msg);
              contentFilterCount++;
              this.deps.logger.warn(
                { modelId, finishReason: result.finishReason },
                'Extension generateText returned content-filter — trying next model',
              );
              span.addEvent('gen.model_content_filter', {
                'gen.modelId': modelId,
                'gen.finishReason': result.finishReason,
              });
              continue;
            }

            span.setAttribute('gen.outcome', 'success');
            span.setAttribute('gen.modelId', modelId);
            span.setAttribute('gen.finishReason', result.finishReason);
            span.setAttribute(
              'gen.usage.inputTokens',
              result.usage.inputTokens ?? 0,
            );
            span.setAttribute(
              'gen.usage.outputTokens',
              result.usage.outputTokens ?? 0,
            );
            span.setAttribute(
              'gen.usage.totalTokens',
              result.usage.totalTokens ?? 0,
            );
            span.setAttribute('gen.outputLength', result.text.length);
            span.addEvent('gen.success', {
              'gen.modelId': modelId,
              'gen.finishReason': result.finishReason,
            });

            return {
              success: true as const,
              text: result.text,
              modelId,
              usage: result.usage,
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            failures.push(`${modelId}: ${msg}`);
            this.deps.logger.warn(
              { error, modelId },
              'Extension generateText model failed — trying next',
            );
            span.addEvent('gen.model_failed', {
              'gen.modelId': modelId,
              'gen.error': msg,
            });
          }
        }

        const allContentFilter =
          contentFilterCount > 0 && contentFilterCount === modelIds.length;

        span.setAttribute(
          'gen.outcome',
          allContentFilter ? 'content-filter' : 'all-models-failed',
        );
        span.setAttribute('gen.failureDetails', failures.join('; '));
        span.setAttribute('gen.contentFilterCount', contentFilterCount);
        span.addEvent('gen.all_models_failed', {
          allContentFilter,
        });

        return {
          success: false as const,
          failureReason: allContentFilter
            ? ('content-filter' as const)
            : ('all-models-failed' as const),
          failureDetails: failures.join('; '),
        };
      });
    } finally {
      span.end();
    }
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

    this.runtimeState = 'working';

    let needsBackoffRetry = false;

    try {
      while (true) {
        // If the session has been terminated (e.g. via close()), stop
        // looping immediately. This check is especially important when
        // close() interrupts a backoff wait — the loop wakes up and must
        // exit rather than starting another turn.
        if (this._status === 'terminated') {
          this.deps.logger.info(
            { sessionId: this.sessionId },
            'Session terminated — stopping loop',
          );
          return;
        }

        // If the inbox is empty AND we're not in a backoff retry cycle,
        // go idle.
        if (this.sessionInbox.isEmpty() && !needsBackoffRetry) {
          this.runtimeState = 'idle';
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
          tools: this.tools,
          modelProvider: this.deps.modelProvider,
          fallbackManager: this.fallbackManager,
          config: this.deps.config,
          forceContinue: needsBackoffRetry,
        });
        this.currentTurn = turn;

        let turnResult: TurnResult;
        try {
          turnResult = await turn.run();
        } finally {
          this.currentTurn = null;
        }

        // Update observability counters.
        this.turnCount++;
        this.stepCount += turnResult.stepCount;
        if (turnResult.usage) {
          this.latestChatUsage = turnResult.usage;
          this.totalChatUsage = {
            inputTokens:
              this.totalChatUsage.inputTokens + turnResult.usage.inputTokens,
            outputTokens:
              this.totalChatUsage.outputTokens + turnResult.usage.outputTokens,
            inputCacheWriteTokens:
              this.totalChatUsage.inputCacheWriteTokens +
              turnResult.usage.inputCacheWriteTokens,
            inputCacheReadTokens:
              this.totalChatUsage.inputCacheReadTokens +
              turnResult.usage.inputCacheReadTokens,
          };
        } else {
          this.latestChatUsage = null;
        }

        // Fatal error — terminate the session.
        if (turnResult.fatalError) {
          this.runtimeState = 'terminated';
          this.deps.logger.error(
            { sessionId: this.sessionId },
            'Fatal turn error — terminating session',
          );
          this.sessionSpan.addEvent('session.fatal_error', {
            'session.id': this.sessionId,
          });
          this.sessionSpan.setAttribute('session.terminated', true);
          await this.terminate(turnResult.fatalErrorReason ?? 'unknown');
          return;
        }

        // Track success/failure for backoff.
        if (turnResult.completeFailure) {
          this.runtimeState = 'retrying';
          this.backoffManager.recordFailure();
          needsBackoffRetry = true;

          // Terminate after too many consecutive failures to prevent
          // infinite retry loops.
          if (
            this.backoffManager.getConsecutiveFailures() >=
            MAX_CONSECUTIVE_FAILURES
          ) {
            this.deps.logger.error(
              {
                sessionId: this.sessionId,
                consecutiveFailures:
                  this.backoffManager.getConsecutiveFailures(),
              },
              'Max consecutive failures reached — terminating session',
            );
            this.sessionSpan.addEvent('session.max_failures_exceeded', {
              'session.consecutiveFailures':
                this.backoffManager.getConsecutiveFailures(),
            });
            this.sessionSpan.setAttribute('session.terminated', true);
            await this.terminate('max_consecutive_failures');
            return;
          }
        } else {
          this.runtimeState = 'success';
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

        this.runtimeState = 'retrying';
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
    } catch (error) {
      this.deps.logger.error(
        { sessionId: this.sessionId, error },
        'Unhandled error in session loop — terminating session',
      );
      this.sessionSpan.addEvent('session.unhandled_error', {
        'session.id': this.sessionId,
        error: String(error),
      });
      this.sessionSpan.setAttribute('session.terminated', true);
      try {
        await this.terminate('unhandled_loop_error');
      } catch (terminateError) {
        this.deps.logger.error(
          { sessionId: this.sessionId, error: terminateError },
          'Failed to terminate session after unhandled loop error',
        );
      }
    } finally {
      this.loopActive = false;
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

  public getSessionInfo(): SessionInfo {
    const modelId = this.fallbackManager.getChatModelId();
    const fallbackIndex = this.fallbackManager.getFallbackIndex();

    // Build per-extension usage snapshot.
    const extensions: Record<string, UsagePair> = {};
    for (const [identifier, pair] of this.extensionUsage) {
      extensions[identifier] = {
        latest: pair.latest,
        total: { ...pair.total },
      };
    }

    return {
      id: this.sessionId,
      status: this._status,
      runtimeState:
        this._status === 'terminated' ? 'terminated' : this.runtimeState,
      model: {
        id: modelId,
        isFallback: fallbackIndex > 0,
        fallbackIndex,
      },
      usage: {
        chat: {
          latest: this.latestChatUsage,
          total: { ...this.totalChatUsage },
        },
        extensions,
      },
      turns: this.turnCount,
      steps: this.stepCount,
      messageCount: this.messages.length,
      createdAt: this.createdAt,
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this._status = 'terminated';
    this.runtimeState = 'terminated';

    this.closePromise = (async () => {
      // Close the inbox first — no new input can enter the session after
      // this point. Any concurrent send() calls will throw
      // SessionInboxClosedError.
      this.sessionInbox.close();

      // Abort in-flight generation and tool execution so that pending
      // network requests and background tasks are cancelled immediately.
      this.currentTurn?.abortGeneration('session_shutdown');
      this.currentTurn?.abortTools();

      // Interrupt any pending backoff wait so the loop can exit promptly.
      this.backoffInterrupt?.();

      await this.extensionHandler.close();
      this.sessionSpan.addEvent('session.closed', {
        'session.id': this.sessionId,
        'session.messageCount': this.messages.length,
      });
      this.sessionSpan.setAttribute(
        'session.closedAt',
        new Date().toISOString(),
      );
      this.sessionSpan.end();
      this.deps.logger.info(
        { sessionId: this.sessionId },
        'Session closed — session span ended',
      );
    })();

    return this.closePromise;
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

    // Drain remaining inbox events so the router can re-dispatch them
    // to the replacement session. getEvents(Low) drains all priorities.
    // Safe to call after close().
    const pendingEvents = this.sessionInbox.getEvents(SessionInboxPriority.Low);

    // Now perform the standard close (span end, status update, etc.).
    // close() will call sessionInbox.close() again — that's a no-op.
    await this.close();

    this.deps.logger.info(
      {
        sessionId: this.sessionId,
        pendingEvents: pendingEvents.length,
      },
      'Session self-terminated — firing onTerminated hook',
    );

    await this.deps.hooks?.onTerminated?.({
      sessionId: this.sessionId,
      reason,
      pendingEvents,
    });
  }

  restorePendingEvents(events: SessionInboxEvent[]): void {
    for (const event of events) {
      try {
        this.sessionInbox.send(event);
      } catch {
        // Inbox may have been closed between event recovery and send.
        // Drop silently — the router will not retry.
      }
    }
  }

  async getExtensionState(
    extensionId: string,
  ): Promise<Record<string, unknown> | null | undefined> {
    return this.extensionHandler.getExtensionState(extensionId);
  }

  getExtensions(): Record<string, { displayName?: string }> {
    return this.extensionHandler.getExtensions();
  }
}

export function createChatSession(deps: ChatSessionDependencies): AgentSession {
  return new ChatSessionModule({
    logger: deps.logging.child({
      name: 'chat-session',
      bindings: { module: 'chat-session' },
    }),
    logging: deps.logging,
    modelProvider: deps.modelProvider,
    config: deps.config,
    dataDirectory: deps.dataDirectory,
    mcp: deps.mcp,
    extensionFactories: deps.extensionFactories,
    hooks: deps.hooks,
  });
}
