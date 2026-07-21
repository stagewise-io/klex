import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import { streamText } from 'ai';
import type { Config, ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { AgentTools } from '@/session/tools';
import { getReplSandboxTools } from '@/session/tools/js-repl-sandbox';
import { getMemoryTools } from '@/session/tools/memory';
import type { AgentSession, ExtendedUIMessage } from '@/session/types';
import { convertToModelMessagesExtended } from './utils/convert-to-model-messages';
import systemPrompt from './utils/system-prompt.md';

export interface ChatSessionDependencies {
  logging: RootLogger;
  modelProvider: ModelProvider;
  config: Config;
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
      tools: AgentTools;
    },
  ) {}

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
  return new ChatSessionModule({
    logger: deps.logging.child({
      name: 'chat-session',
      bindings: { module: 'chat-session' },
    }),
    modelProvider: deps.modelProvider,
    config: deps.config,
    tools: {
      ...getMemoryTools(),
      ...getReplSandboxTools(),
    },
  });
}
