import type { ModelMessage } from 'ai';

export interface GeminiPart {
  readonly text?: string;
  readonly functionCall?: {
    readonly id?: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  };
  readonly functionResponse?: {
    readonly id?: string;
    readonly name: string;
    readonly response: Record<string, unknown>;
  };
}

export interface GeminiContentTurn {
  readonly role: 'user' | 'model';
  readonly parts: readonly GeminiPart[];
}

function collectText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.length > 0
    ) {
      chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

function extractToolResponse(output: unknown): Record<string, unknown> {
  let value = output;
  if (typeof output === 'object' && output !== null && 'value' in output) {
    value = (output as { value: unknown }).value;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

export function toGeminiContentTurns(
  messages: readonly ModelMessage[],
): GeminiContentTurn[] {
  const turns: GeminiContentTurn[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const text =
          typeof message.content === 'string'
            ? message.content
            : collectText(message.content);
        if (text.trim().length > 0) {
          turns.push({
            role: 'user',
            parts: [{ text: `[System Instruction]:\n${text}` }],
          });
        }
        break;
      }
      case 'user': {
        const text = collectText(message.content);
        if (text.trim().length > 0) {
          turns.push({
            role: 'user',
            parts: [{ text }],
          });
        }
        break;
      }
      case 'assistant': {
        const parts: GeminiPart[] = [];
        const text = collectText(message.content);
        if (text.trim().length > 0) {
          parts.push({ text });
        }
        if (
          typeof message.content !== 'string' &&
          Array.isArray(message.content)
        ) {
          for (const part of message.content) {
            if (part.type === 'tool-call') {
              parts.push({
                functionCall: {
                  id: part.toolCallId,
                  name: part.toolName,
                  args: (part.input as Record<string, unknown>) ?? {},
                },
              });
            }
          }
        }
        if (parts.length > 0) {
          turns.push({
            role: 'model',
            parts,
          });
        }
        break;
      }
      case 'tool': {
        const parts: GeminiPart[] = [];
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'tool-result') {
              parts.push({
                functionResponse: {
                  id: part.toolCallId,
                  name: part.toolName,
                  response: extractToolResponse(part.output),
                },
              });
            }
          }
        }
        if (parts.length > 0) {
          turns.push({
            role: 'user',
            parts,
          });
        }
        break;
      }
    }
  }

  return turns;
}
