import type { ModelMessage } from 'ai';
import { getEncoding } from 'js-tiktoken';

import { serializeValue } from '@/session/chat/utils/history-view';
import type {
  InteractionToolDescriptor,
  PreparedInferenceContext,
} from '@/session/interaction';

const tokenizer = getEncoding('o200k_base');

const MAX_HISTORY_TEXT_CHARACTERS = 131_072;
const DEFAULT_MAX_HISTORY_TOKENS = 32_000;

export interface GPTLiveSessionConfigOptions {
  readonly modelId?: string;
  readonly responsesModel: string;
  readonly frontendInstructions: string;
  readonly voice?: string;
  readonly maxFrontendInstructionTokens?: number;
  readonly maxBackendInstructionTokens?: number;
  readonly maxHistoryTokens?: number;
}

interface GPTLiveInitialItem {
  readonly type: 'message';
  readonly role: 'developer' | 'user' | 'assistant';
  readonly status: 'completed';
  readonly content: readonly [
    {
      readonly type: 'input_text' | 'output_text';
      readonly text: string;
    },
  ];
}

interface GPTLiveFunctionTool {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: false;
}

export interface GPTLiveSessionConfig {
  readonly model: string;
  readonly instructions: string;
  readonly audio: {
    readonly format: { readonly type: 'audio/pcm'; readonly rate: 24_000 };
    readonly output: { readonly voice?: string };
  };
  readonly input: readonly GPTLiveInitialItem[];
  readonly delegation: {
    readonly type: 'responses';
    readonly responses: {
      readonly model: string;
      readonly instructions: string;
      readonly tools: readonly GPTLiveFunctionTool[];
    };
  };
}

export interface GPTLivePreparedSession {
  readonly session: GPTLiveSessionConfig;
  readonly omittedHistoryMessages: number;
}

export function buildGPTLiveSessionConfig(
  context: PreparedInferenceContext,
  options: GPTLiveSessionConfigOptions,
): GPTLivePreparedSession {
  const maxFrontendInstructionTokens = positiveInteger(
    options.maxFrontendInstructionTokens ?? 12_000,
    'maxFrontendInstructionTokens',
  );
  const maxBackendInstructionTokens = positiveInteger(
    options.maxBackendInstructionTokens ?? 12_000,
    'maxBackendInstructionTokens',
  );
  const maxHistoryTokens = positiveInteger(
    options.maxHistoryTokens ?? DEFAULT_MAX_HISTORY_TOKENS,
    'maxHistoryTokens',
  );

  assertWithinTokenBudget(
    options.frontendInstructions,
    maxFrontendInstructionTokens,
    'GPT-Live frontend instructions',
  );
  assertWithinTokenBudget(
    context.instructions,
    maxBackendInstructionTokens,
    'Responses backend instructions',
  );

  const projected = context.messages
    .map(toInitialItem)
    .filter((item): item is GPTLiveInitialItem => item !== undefined);
  const input = retainNewestHistory(
    projected,
    Math.min(maxHistoryTokens, 32_000),
  );

  return {
    session: {
      model: options.modelId ?? 'gpt-live-1',
      instructions: options.frontendInstructions,
      audio: {
        format: { type: 'audio/pcm', rate: 24_000 },
        output: {
          ...(options.voice === undefined ? {} : { voice: options.voice }),
        },
      },
      input: input.items,
      delegation: {
        type: 'responses',
        responses: {
          model: options.responsesModel,
          instructions: context.instructions,
          tools: toFunctionTools(context.tools),
        },
      },
    },
    omittedHistoryMessages: projected.length - input.items.length,
  };
}

function toInitialItem(message: ModelMessage): GPTLiveInitialItem | undefined {
  const text = collectText(message);
  if (text.length === 0) return undefined;

  switch (message.role) {
    case 'system':
      return {
        type: 'message',
        role: 'developer',
        status: 'completed',
        content: [{ type: 'input_text', text }],
      };
    case 'user':
      return {
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text }],
      };
    case 'assistant':
      return {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      };
    case 'tool':
      return {
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text }],
      };
  }
}

function collectText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content.trim();
  return message.content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text.trim();
        case 'tool-call':
          return `[Prior tool call ${part.toolName} (${part.toolCallId}): ${serializeValue(part.input, { max: 1_000, truncate: 'end-overflow', json: 'compact' }) ?? 'null'}]`;
        case 'tool-result':
          return `[Prior tool result ${part.toolName} (${part.toolCallId}): ${serializeValue(part.output, { max: 1_000, truncate: 'end-overflow', json: 'compact' }) ?? 'null'}]`;
        default:
          return '';
      }
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function hasCompactionSummary(text: string): boolean {
  const start = text.indexOf('<summary>');
  if (start === -1) return false;
  const end = text.indexOf('</summary>', start + '<summary>'.length);
  return end !== -1;
}

function retainNewestHistory(
  items: readonly GPTLiveInitialItem[],
  maxTokens: number,
): { items: GPTLiveInitialItem[] } {
  const retained: GPTLiveInitialItem[] = [];
  const newest = items.at(-1);
  if (newest === undefined) return { items: retained };
  if (newest.content[0].text.length > MAX_HISTORY_TEXT_CHARACTERS)
    throw new Error(
      'Newest GPT-Live history message exceeds text character budget',
    );
  const newestTokens = countInitialItemTokens(newest);
  if (newestTokens > maxTokens)
    throw new Error('Newest GPT-Live history message exceeds token budget');

  const first = items[0];
  const summaryIndex =
    first?.role === 'assistant' &&
    hasCompactionSummary(first.content[0]?.text ?? '') &&
    items.length > 1
      ? 0
      : -1;
  let summary: GPTLiveInitialItem | undefined;
  let usedTokens = 0;
  if (
    summaryIndex === 0 &&
    first !== undefined &&
    first.content[0].text.length <= MAX_HISTORY_TEXT_CHARACTERS
  ) {
    const summaryTokens = countInitialItemTokens(first);
    if (summaryTokens + newestTokens <= maxTokens) {
      summary = first;
      usedTokens = summaryTokens;
    }
  }

  for (let index = items.length - 1; index > summaryIndex; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    const text = item.content[0]?.text ?? '';
    if (text.length > MAX_HISTORY_TEXT_CHARACTERS) break;
    const tokens = countInitialItemTokens(item);
    if (tokens > maxTokens - usedTokens) break;
    retained.push(item);
    usedTokens += tokens;
  }

  retained.reverse();
  if (summary !== undefined) retained.unshift(summary);
  return { items: retained };
}

function countInitialItemTokens(item: GPTLiveInitialItem): number {
  const text = item.content[0]?.text ?? '';
  // Include a conservative per-message allowance for role and envelope tokens.
  return tokenizer.encode(text).length + 8;
}

function toFunctionTools(
  tools: readonly InteractionToolDescriptor[],
): GPTLiveFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    parameters: tool.inputSchema,
    strict: false,
  }));
}

function assertWithinTokenBudget(
  text: string,
  maxTokens: number,
  name: string,
): void {
  const tokens = tokenizer.encode(text).length;
  if (tokens > maxTokens)
    throw new Error(`${name} exceeds its ${maxTokens}-token budget`);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
