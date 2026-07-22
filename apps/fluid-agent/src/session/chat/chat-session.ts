import { streamText } from 'ai';

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

import { convertToModelMessagesExtended } from './utils/convert-to-model-messages';
import systemPrompt from './utils/system-prompt.md';

export interface ChatSessionDependencies {
  logging: RootLogger;
  modelProvider: ModelProvider;
  config: Config;
  toolProvider: ToolProvider;
}

class ChatSessionModule implements AgentSession {
  private readonly info: string[] = [];

  private messages: ExtendedUIMessage[] = [];

  // Stores the index of the model we use.
  private modelFallbackIndex = 0;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      modelProvider: ModelProvider;
      config: Config;
      javaScriptTool: JavaScriptTool;
      tools: AgentTools;
    },
  ) {}

  async start(): Promise<void> {
    await this.deps.javaScriptTool.start();
    this.deps.logger.info('ChatSession started');
  }

  async close(): Promise<void> {
    await this.deps.javaScriptTool.close();
    this.deps.logger.info('ChatSession stopped');
  }

  inform(info: string): void {
    this.info.push(info);
    this.deps.logger.info({ info }, 'ChatSession informed');
  }

  async runStep() {
    const modelId = this.getChatModelId();
    const model = await this.deps.modelProvider.get(modelId);

    const stream = streamText({
      model: model,
      instructions: {
        role: 'system',
        content: systemPrompt,
      },
      messages: await convertToModelMessagesExtended(this.messages),
      tools: this.deps.tools,
    });

    for await (const chunk of stream.stream) {
      this.deps.logger.info({ chunk }, 'ChatSession received chunk');
    }
  }

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

  /**
   * Public API
   */
  public sendMessage = (input: string) => {
    // Push the message into the history in some fake context format as if it's an input from a chat app
    const message: ExtendedUIMessage = {
      role: 'user',
      id: 'test-data-part-id',
      parts: [
        {
          type: 'data-context',
          data: {
            sourceEnv: 'chatApp',
            metadata: {
              chatId: '95g8743',
              senderId: 'u4987tzrh4',
              timestamp: '2 minutes ago',
            },
            content: [
              {
                type: 'text',
                text: input,
              },
            ],
          },
        },
      ],
    };
    this.messages.push(message);

    void this.runStep();
  };
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
    modelProvider: deps.modelProvider,
    config: deps.config,
    javaScriptTool,
    tools: {
      ...getMemoryTools(),
      ...javaScriptTool.tools,
    },
  });
}
