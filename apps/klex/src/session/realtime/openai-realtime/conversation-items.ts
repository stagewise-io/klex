import type { ModelMessage } from 'ai';

import type { InteractionToolDescriptor } from '@/session/interaction';

/**
 * OpenAI Realtime wire-format construction.
 *
 * The shared interaction contracts speak AI SDK `ModelMessage` and
 * provider-neutral tool descriptors; converting them to realtime
 * conversation items and session tools is adapter-local knowledge and
 * stays here.
 */

/** Conversation item payload accepted by `conversation.item.create`. */
export type ConversationItem = Readonly<Record<string, unknown>>;

/** Function tool payload accepted by `session.update`. */
export interface SessionFunctionTool {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Projects prepared history onto realtime conversation items.
 *
 * Only content the realtime conversation can represent is seeded: text,
 * function calls, and function outputs. Images, files, and reasoning
 * parts are skipped rather than approximated, and messages that end up
 * empty are dropped so the provider never receives an item without
 * content.
 */
export function toConversationItems(
  messages: readonly ModelMessage[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        appendText(items, 'system', 'input_text', message.content);
        break;
      case 'user':
        appendText(items, 'user', 'input_text', collectText(message.content));
        break;
      case 'assistant': {
        appendText(
          items,
          'assistant',
          'output_text',
          collectText(message.content),
        );
        if (typeof message.content === 'string') break;
        for (const part of message.content) {
          if (part.type !== 'tool-call') continue;
          items.push({
            type: 'function_call',
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          });
        }
        break;
      }
      case 'tool': {
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue;
          items.push({
            type: 'function_call_output',
            call_id: part.toolCallId,
            output: stringifyToolOutput(part.output),
          });
        }
        break;
      }
    }
  }
  return items;
}

export function toSessionTools(
  tools: readonly InteractionToolDescriptor[],
): SessionFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    parameters: tool.inputSchema,
  }));
}

/** Builds the user conversation item used for live context updates. */
export function userTextItem(text: string): ConversationItem {
  return textItem('user', 'input_text', text);
}

/** Builds the assistant conversation item retained across reconnects. */
export function assistantTextItem(text: string): ConversationItem {
  return textItem('assistant', 'output_text', text);
}

function textItem(
  role: 'user' | 'assistant',
  contentType: 'input_text' | 'output_text',
  text: string,
): ConversationItem {
  return {
    type: 'message',
    role,
    content: [{ type: contentType, text }],
  };
}

/** Builds the function output item returned after a tool execution. */
export function functionOutputItem(
  callId: string,
  output: string,
): ConversationItem {
  return { type: 'function_call_output', call_id: callId, output };
}

function appendText(
  items: ConversationItem[],
  role: 'system' | 'user' | 'assistant',
  contentType: 'input_text' | 'output_text',
  text: string,
): void {
  if (text.length === 0) return;
  items.push({
    type: 'message',
    role,
    content: [{ type: contentType, text }],
  });
}

function collectText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text.length > 0) chunks.push(part.text);
  }
  return chunks.join('\n');
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null && 'value' in output) {
    // AI SDK tool outputs are wrapped in a `{ type, value }` envelope; the
    // provider must see the payload, not the envelope.
    const value: unknown = output.value;
    if (typeof value === 'string') return value;
    return safeJson(value);
  }
  return safeJson(output);
}

function safeJson(output: unknown): string {
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return '"[unserializable tool output]"';
  }
}
