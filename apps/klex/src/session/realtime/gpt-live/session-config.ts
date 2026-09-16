import type { ModelMessage } from 'ai';
import { getEncoding } from 'js-tiktoken';

import type {
  InteractionToolDescriptor,
  PreparedInferenceContext,
} from '@/session/interaction';

const tokenizer = getEncoding('o200k_base');

const MAX_HISTORY_TEXT_CHARACTERS = 131_072;
const MAX_HISTORY_TOOL_VALUE_CHARACTERS = 16_384;
const MAX_HISTORY_TOOL_VALUE_NODES = 128;
const MAX_HISTORY_TOOL_VALUE_DEPTH = 16;
const MAX_HISTORY_TOOL_STRING_CHARACTERS = 1_024;
const MAX_HISTORY_TOOL_COLLECTION_ENTRIES = 128;

export interface GPTLiveSessionConfigOptions {
  readonly responsesModel: string;
  readonly frontendInstructions: string;
  readonly voice?: string;
  readonly maxFrontendInstructionTokens?: number;
  readonly maxBackendInstructionTokens?: number;
  readonly maxHistoryTokens?: number;
  readonly maxHistoryMessages?: number;
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
  readonly model: 'gpt-live-1';
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
    options.maxHistoryTokens ?? 7_000,
    'maxHistoryTokens',
  );
  const maxHistoryMessages = positiveInteger(
    options.maxHistoryMessages ?? 128,
    'maxHistoryMessages',
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
    Math.min(maxHistoryMessages, 128),
    Math.min(maxHistoryTokens, 8_192),
  );

  return {
    session: {
      model: 'gpt-live-1',
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
          return `[Prior tool call ${part.toolName} (${part.toolCallId}): ${safeStringify(part.input)}]`;
        case 'tool-result':
          return `[Prior tool result ${part.toolName} (${part.toolCallId}): ${safeStringify(part.output)}]`;
        default:
          return '';
      }
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function retainNewestHistory(
  items: readonly GPTLiveInitialItem[],
  maxMessages: number,
  maxTokens: number,
): { items: GPTLiveInitialItem[] } {
  const retained: GPTLiveInitialItem[] = [];
  let usedTokens = 0;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (retained.length >= maxMessages) break;
    const item = items[index];
    if (item === undefined) continue;
    const text = item.content[0]?.text ?? '';
    if (text.length > MAX_HISTORY_TEXT_CHARACTERS) {
      if (index === items.length - 1)
        throw new Error(
          'Newest GPT-Live history message exceeds text character budget',
        );
      continue;
    }
    const tokens = countInitialItemTokens(item);
    if (index === items.length - 1 && tokens > maxTokens)
      throw new Error('Newest GPT-Live history message exceeds token budget');
    if (tokens > maxTokens - usedTokens) continue;
    retained.push(item);
    usedTokens += tokens;
  }

  retained.reverse();
  return { items: retained };
}

function countInitialItemTokens(item: GPTLiveInitialItem): number {
  const text = item.content[0]?.text ?? '';
  // Include a conservative per-message allowance for role and envelope tokens.
  return tokenizer.encode(text).length + 8;
}

function safeStringify(value: unknown): string {
  try {
    const budget = { nodes: MAX_HISTORY_TOOL_VALUE_NODES };
    const bounded = toBoundedSerializable(value, budget, new WeakSet(), 0);
    const serialized = JSON.stringify(bounded) ?? 'null';
    return serialized.length <= MAX_HISTORY_TOOL_VALUE_CHARACTERS
      ? serialized
      : `${serialized.slice(0, MAX_HISTORY_TOOL_VALUE_CHARACTERS)}…`;
  } catch {
    return '[unserializable]';
  }
}

function toBoundedSerializable(
  value: unknown,
  budget: { nodes: number },
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (budget.nodes <= 0) return '[truncated]';
  budget.nodes -= 1;
  if (typeof value === 'string')
    return value.length <= MAX_HISTORY_TOOL_STRING_CHARACTERS
      ? value
      : `${value.slice(0, MAX_HISTORY_TOOL_STRING_CHARACTERS)}…`;
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return value;
  if (typeof value !== 'object') return `[unsupported ${typeof value}]`;
  if (ancestors.has(value)) return '[circular]';
  if (depth >= MAX_HISTORY_TOOL_VALUE_DEPTH) return '[max depth]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const count = Math.min(value.length, MAX_HISTORY_TOOL_COLLECTION_ENTRIES);
      for (let index = 0; index < count && budget.nodes > 0; index += 1)
        result.push(
          toBoundedSerializable(value[index], budget, ancestors, depth + 1),
        );
      if (count < value.length || budget.nodes <= 0) result.push('[truncated]');
      return result;
    }

    const result: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count >= MAX_HISTORY_TOOL_COLLECTION_ENTRIES || budget.nodes <= 0) {
        result['[truncated]'] = true;
        break;
      }
      result[key.slice(0, MAX_HISTORY_TOOL_STRING_CHARACTERS)] =
        toBoundedSerializable(
          (value as Record<string, unknown>)[key],
          budget,
          ancestors,
          depth + 1,
        );
      count += 1;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
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
