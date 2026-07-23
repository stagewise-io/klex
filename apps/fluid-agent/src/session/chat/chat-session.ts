import { randomUUID } from 'node:crypto';

import { type Context, context, type Span, trace } from '@opentelemetry/api';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config, ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { AgentTools } from '@/session/tools';
import {
  createJavaScriptTool,
  type JavaScriptTool,
} from '@/session/tools/javascript';
import { getMemoryTools } from '@/session/tools/memory';
import type { AgentSession, ExtendedUIMessage } from '@/session/types';
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
import { createTurn, type Turn } from './turn';

export interface ChatSessionDependencies {
  logging: RootLogger;
  modelProvider: ModelProvider;
  config: Config;
  toolProvider: ToolProvider;
  extensionFactories: ExtensionFactory[];
}

class ChatSessionModule implements AgentSession {
  private messages: ExtendedUIMessage[] = [];

  private readonly sessionInbox: SessionInboxBuffer;

  private readonly extensionHandler: ExtensionHandler;

  private modelFallbackIndex = 0;

  private loopActive = false;

  private currentTurn: Turn | null = null;

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
    },
  ) {
    // Create a session-level span that lives for the entire session lifetime.
    // All turn / step / generation spans inherit this trace, giving a single
    // trace tree per session in the tracing backend. The span stays open until
    // close() is called — child spans (turns, steps) are exported as they end,
    // so the trace is visible in real time even while the session span is open.
    this.sessionSpan = trace.getTracer('fluid-agent').startSpan('session', {
      attributes: {
        'session.id': this.sessionId,
        'session.createdAt': new Date().toISOString(),
      },
    });
    this.sessionContext = trace.setSpan(context.active(), this.sessionSpan);

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
    // with this session's history asynchronously.
    const extensionDeps: ExtensionDeps = {
      getHistory: () => [...this.messages],
      addMessage: (msg, insertBeforeId) => {
        if (insertBeforeId) {
          const idx = this.messages.findIndex((m) => m.id === insertBeforeId);
          if (idx === -1) {
            this.deps.logger.warn(
              { id: insertBeforeId },
              'addMessage: insertBeforeId not found, appending to end',
            );
            this.messages.push(msg);
          } else {
            this.messages.splice(idx, 0, msg);
          }
        } else {
          this.messages.push(msg);
        }
      },
      updateMessage: (id, update) => {
        const idx = this.messages.findIndex((m) => m.id === id);
        if (idx === -1) {
          this.deps.logger.warn({ id }, 'updateMessage: message not found');
          return;
        }
        const existing = this.messages[idx];
        if (!existing) return;
        this.messages[idx] = {
          ...existing,
          ...update,
          id: existing.id,
        } as ExtendedUIMessage;
      },
      inbox: this.sessionInbox,
    };

    this.extensionHandler = createExtensionHandler({
      logging: deps.logging,
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
      this.currentTurn.abortGeneration();
    }

    // If no turn is active, start one (architecture step 1).
    if (!this.loopActive) {
      void this.runLoop();
    }
  };

  /**
   * The main turn loop. Creates a Turn module per iteration so that the
   * Turn's lifetime (and its span) covers exactly one turn. Runs until no
   * more input is available, then goes idle.
   */
  private async runLoop(): Promise<void> {
    if (this.loopActive) return;
    this.loopActive = true;

    while (!this.sessionInbox.isEmpty()) {
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
        getChatModelId: () => this.getChatModelId(),
        getModelFallbackIndex: () => this.modelFallbackIndex,
        fallbackToNextModel: () => this.fallbackToNextModel(),
      });
      this.currentTurn = turn;

      try {
        await turn.run();
      } finally {
        this.currentTurn = null;
      }
    }

    this.loopActive = false;
    this.sessionSpan.addEvent('session.idle', {
      'session.id': this.sessionId,
    });
  }

  // ---------------------------------------------------------------------------
  // Model selection
  // ---------------------------------------------------------------------------

  getChatModelId(): ModelId {
    const modelListLength = this.deps.config.get().modelSelection.chat.length;
    const index = this.modelFallbackIndex % modelListLength;
    const modelId = this.deps.config.get().modelSelection.chat[index];
    if (!modelId) {
      throw new Error('No chat model selected in configuration');
    }
    return modelId;
  }

  fallbackToNextModel(): void {
    const modelListLength = this.deps.config.get().modelSelection.chat.length;
    this.modelFallbackIndex = (this.modelFallbackIndex + 1) % modelListLength;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public get inbox(): SessionInbox {
    return this.sessionInbox;
  }

  async close(): Promise<void> {
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
  });
}
