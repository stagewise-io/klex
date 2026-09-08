import type { ProviderDefinition } from '../provider-registry';
import { alibabaQwenProviderDefinition } from './alibaba-qwen';
import { amazonBedrockProviderDefinition } from './amazon-bedrock';
import { anthropicProviderDefinition } from './anthropic';
import { anthropicMessagesProviderDefinition } from './anthropic-messages';
import { azureOpenAiProviderDefinition } from './azure-openai';
import { chatCompletionsProviderDefinition } from './chat-completions';
import { chatGptCodexSubscriptionProviderDefinition } from './chatgpt-codex-subscription';
import { deepSeekProviderDefinition } from './deepseek';
import { glmCodingPlanProviderDefinition } from './glm-coding-plan';
import { googleGeminiProviderDefinition } from './google-gemini';
import { googleGenerativeProviderDefinition } from './google-generative';
import { googleVertexProviderDefinition } from './google-vertex';
import { minimaxProviderDefinition } from './minimax';
import { minimaxCodingPlanProviderDefinition } from './minimax-coding-plan';
import { mistralProviderDefinition } from './mistral';
import { moonshotProviderDefinition } from './moonshot';
import { ollamaProviderDefinition } from './ollama';
import { openAiProviderDefinition } from './openai';
import { openCodeGoProviderDefinition } from './opencode-go';
import { openCodeZenProviderDefinition } from './opencode-zen';
import { openRouterProviderDefinition } from './openrouter';
import { responsesProviderDefinition } from './responses';
import { xaiProviderDefinition } from './xai';
import { xiaomiMimoProviderDefinition } from './xiaomi-mimo';
import { zaiProviderDefinition } from './zai';

export const builtInProviderDefinitions: readonly ProviderDefinition[] = [
  openAiProviderDefinition,
  anthropicProviderDefinition,
  googleGeminiProviderDefinition,
  googleVertexProviderDefinition,
  amazonBedrockProviderDefinition,
  azureOpenAiProviderDefinition,
  openRouterProviderDefinition,
  moonshotProviderDefinition,
  alibabaQwenProviderDefinition,
  deepSeekProviderDefinition,
  zaiProviderDefinition,
  minimaxProviderDefinition,
  xiaomiMimoProviderDefinition,
  mistralProviderDefinition,
  xaiProviderDefinition,
  glmCodingPlanProviderDefinition,
  minimaxCodingPlanProviderDefinition,
  openCodeGoProviderDefinition,
  openCodeZenProviderDefinition,
  chatGptCodexSubscriptionProviderDefinition,
  chatCompletionsProviderDefinition,
  responsesProviderDefinition,
  anthropicMessagesProviderDefinition,
  googleGenerativeProviderDefinition,
  ollamaProviderDefinition,
];
