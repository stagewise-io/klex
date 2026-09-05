import { randomUUID } from 'node:crypto';

import type { JSONObject } from '@ai-sdk/provider';
import { type Context, context, type Span, trace } from '@opentelemetry/api';
import { generateText } from 'ai';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { type Config, modelIdFromEntry } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp } from '@/mcp';
import type { ModelProvider } from '@/model-provider';
import type { RouterApi } from '@/router';
import type { SessionInboxEvent } from '@/session/inbox';
import type {
  AgentSession,
  ChatSessionHandle,
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
  type ChatSessionInbox,
  createInbox,
  type SessionInboxBuffer,
  SessionInboxUrgency,
} from './inbox';
import type { ExtendedUIMessage } from './message-types';
import { createTurn, type Turn, type TurnResult } from './turn';
import { BackoffManager } from './utils/backoff-manager';
import { ModelFallbackManager } from './utils/model-fallback-manager';
import { getExtensionIdentifier, tracer } from './utils/tracing';

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
  router: RouterApi;
  extensionFactories: ExtensionFactory[];
  /** Root data directory of the agent. Used for extension data dirs. */
  dataDirectory: string;
  /** Parent introspection scope (the "sessions" group). The session creates its own child. */
  introspectionScope: IntrospectionScope;
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

  /**
   * Set when non-deferrable input arrives during an active turn.
   * Checked after the turn completes — if true, the loop runs a
   * check-retry turn so the model can review the new input.
   */
  private newInputDuringTurn = false;

  /**
   * Set when any input arrives while the loop is idle.
   * Critical/Default events are appended to history immediately but
   * not buffered in the inbox, so isEmpty() alone cannot detect them.
   * This flag ensures the loop runs a turn to process them.
   */
  private hasPendingInput = false;

  /**
   * Buffer for immediate (Critical/Default) events and messages that
   * arrive while a turn is active. Instead of pushing them to messages[]
   * immediately (which would place them before the in-flight assistant
   * response), they are queued here and flushed after each step commits
   * its response. This preserves response-before-new-input ordering.
   */
  private pendingImmediate: ExtendedUIMessage[] = [];

  readonly sessionId = randomUUID();

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

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      logging: RootLogger;
      modelProvider: ModelProvider;
      config: Config;
      dataDirectory: string;
      mcp: Mcp;
      router: RouterApi;
      extensionFactories: ExtensionFactory[];
      introspectionScope: IntrospectionScope;
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
      onImmediateEvent: this.onImmediateEvent,
      onImmediateMessage: this.onImmediateMessage,
      onNewInput: this.onNewInput,
      logger: this.deps.logger,
    });

    // Register session state in the introspection tree.
    // The parent scope is the "sessions" group — create a child for
    // this specific session using its generated ID.
    const sessionScope = deps.introspectionScope.child(this.sessionId);
    sessionScope.introspect(() => this.getSessionInfo());
    const extensionsScope = sessionScope.child('extensions');

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
      router: this.deps.router,
      sessionId: this.sessionId,
    };

    this.extensionHandler = createExtensionHandler({
      factories: deps.extensionFactories,
      extensionDeps,
      dataDirectory: this.deps.dataDirectory,
      sessionId: this.sessionId,
      introspectionScope: extensionsScope,
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
          'gen.modelIds': modelIds.map((e) => modelIdFromEntry(e)).join(','),
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

        for (const entry of modelIds) {
          const modelId = modelIdFromEntry(entry);
          try {
            const model = await this.deps.modelProvider.get(modelId);
            const resolved = this.deps.config.resolveModel(entry);
            const providerOptions = resolved.providerOptions as
              | Record<string, JSONObject>
              | undefined;
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
                    telemetry: {
                      isEnabled: true,
                      functionId,
                      includeRuntimeContext: {
                        'conversation.id': true,
                        'conversation.modelId': true,
                      },
                    },
                    runtimeContext: {
                      'conversation.id': this.sessionId,
                      'conversation.modelId': modelId,
                    },
                    ...(providerOptions !== undefined && { providerOptions }),
                  }
                : {
                    model,
                    system: args.system,
                    prompt: args.prompt ?? '',
                    tools: args.tools,
                    temperature: args.temperature,
                    maxOutputTokens: args.maxOutputTokens,
                    maxRetries: args.maxRetries ?? 0,
                    telemetry: {
                      isEnabled: true,
                      functionId,
                      includeRuntimeContext: {
                        'conversation.id': true,
                        'conversation.modelId': true,
                      },
                    },
                    runtimeContext: {
                      'conversation.id': this.sessionId,
                      'conversation.modelId': modelId,
                    },
                    ...(providerOptions !== undefined && { providerOptions }),
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

  private onImmediateEvent = (event: SessionInboxEvent): void => {
    const message: ExtendedUIMessage = {
      role: 'user',
      id: randomUUID(),
      parts: [{ type: 'data-context', data: event.context }],
    };

    if (this.loopActive) {
      // Queue — will be flushed after the current step commits its
      // response, preserving response-before-new-input ordering.
      this.pendingImmediate.push(message);
    } else {
      this.messages.push(message);
    }

    // Critical urgency: abort the current generation immediately.
    if (event.urgency === SessionInboxUrgency.Critical && this.currentTurn) {
      this.currentTurn.abortGeneration('inbox_interrupt');
      this.sessionSpan.addEvent('session.generation_aborted', {
        'session.abortReason': 'inbox_interrupt',
        'inbox.urgency': SessionInboxUrgency[event.urgency],
      });
    }
  };

  private onImmediateMessage = (
    message: ExtendedUIMessage,
    urgency: SessionInboxUrgency,
  ): void => {
    if (this.loopActive) {
      // Queue — will be flushed after the current step commits its
      // response, preserving response-before-new-input ordering.
      this.pendingImmediate.push(message);
    } else {
      this.messages.push(message);
    }

    // Critical urgency: abort the current generation immediately.
    if (urgency === SessionInboxUrgency.Critical && this.currentTurn) {
      this.currentTurn.abortGeneration('inbox_interrupt');
      this.sessionSpan.addEvent('session.generation_aborted', {
        'session.abortReason': 'inbox_interrupt',
        'inbox.urgency': SessionInboxUrgency[urgency],
      });
    }
  };

  /**
   * Flushes pending immediate events/messages to the history array.
   * Called by the turn after each step commits its response, ensuring
   * new input appears after the assistant response, not before it.
   */
  private flushPendingImmediate = (): void => {
    if (this.pendingImmediate.length > 0) {
      this.messages.push(...this.pendingImmediate);
      this.pendingImmediate = [];
    }
  };

  private onNewInput = (urgency: SessionInboxUrgency): void => {
    // If currently in a backoff wait, interrupt it so the new input is
    // processed immediately.
    if (this.backoffInterrupt) {
      this.backoffInterrupt();
    }

    // Track that new non-deferrable input arrived during an active turn.
    // Deferrable input is buffered and will be drained at the next turn
    // start, so it does not need a check-retry turn.
    if (this.loopActive && urgency !== SessionInboxUrgency.Deferrable) {
      this.newInputDuringTurn = true;
    }

    // If no turn is active, flag that there is pending input and
    // start the loop. The flag ensures the loop doesn't go idle
    // before processing immediate events that were appended to
    // history but not buffered in the inbox.
    if (!this.loopActive) {
      this.hasPendingInput = true;
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
    let needsCheckRetry = false;

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

        // If the inbox is empty AND no pending immediate input AND
        // we're not in a backoff retry cycle AND no check-retry is
        // needed, go idle.
        if (
          this.sessionInbox.isEmpty() &&
          !this.hasPendingInput &&
          !needsBackoffRetry &&
          !needsCheckRetry
        ) {
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

        // Reset the input flags before each turn so we only detect
        // input that arrives during this specific turn.
        this.newInputDuringTurn = false;
        this.hasPendingInput = false;

        // Run exactly one turn per iteration. The turn drains deferred
        // inbox input and runs steps until no more generation is needed.
        //
        // If we're in a backoff retry cycle, the turn will run even though
        // the inbox may be empty — it retries generation with the existing
        // messages. The turn's step will find the last assistant message
        // (or a "Continue." message from the prior forceNextStep) and retry.
        //
        // If needsCheckRetry is true, the turn injects a data-check message
        // prompting the model to review new input that arrived during the
        // previous turn.
        const turn = createTurn({
          logger: this.deps.logger,
          sessionId: this.sessionId,
          sessionContext: this.sessionContext,
          sessionSpan: this.sessionSpan,
          messages: this.messages,
          inbox: this.sessionInbox,
          extensionHandler: this.extensionHandler,
          modelProvider: this.deps.modelProvider,
          fallbackManager: this.fallbackManager,
          config: this.deps.config,
          forceContinue: needsBackoffRetry,
          forceCheck: needsCheckRetry,
          flushPendingImmediate: this.flushPendingImmediate,
        });
        this.currentTurn = turn;

        let turnResult: TurnResult;
        try {
          turnResult = await turn.run();
        } finally {
          this.currentTurn = null;
          // Flush any pending events that arrived after the last step
          // committed but before the turn returned.
          this.flushPendingImmediate();
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
          needsCheckRetry = false;

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
          // Check if new non-deferrable input arrived during this turn.
          // If so, run a check-retry turn so the model can review it.
          needsCheckRetry = this.newInputDuringTurn;
        }

        // If the turn succeeded or was a no-op, and no check-retry is
        // needed, loop back to the top to check for more inbox input or
        // go idle.
        if (!needsBackoffRetry && !needsCheckRetry) {
          continue;
        }

        // If a check-retry is needed (and no backoff), loop back to run
        // a check-retry turn.
        if (!needsBackoffRetry && needsCheckRetry) {
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

  public get inbox(): ChatSessionInbox {
    return this.sessionInbox;
  }

  public get status(): SessionStatus {
    return this._status;
  }

  public getSessionInfo(): SessionInfo {
    const modelEntry = this.fallbackManager.getChatModelEntry();
    const modelId = modelEntry ? modelIdFromEntry(modelEntry) : null;
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

  public getMessages(): readonly ExtendedUIMessage[] {
    return [...this.messages];
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

      // Remove this session from the introspection tree. The session
      // registered itself as a child of the "sessions" scope in the
      // constructor — it owns its own lifecycle in the tree.
      this.deps.introspectionScope.removeChild(this.sessionId);

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

    // Drain remaining deferred inbox events so the router can re-dispatch them
    // to the replacement session.
    const pendingEvents = this.sessionInbox.getEvents();

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
}

export function createChatSession(
  deps: ChatSessionDependencies,
): ChatSessionHandle {
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
    router: deps.router,
    extensionFactories: deps.extensionFactories,
    introspectionScope: deps.introspectionScope,
    hooks: deps.hooks,
  });
}
