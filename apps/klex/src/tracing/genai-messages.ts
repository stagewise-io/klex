import type { Instructions, ModelMessage } from 'ai';

/**
 * Converters from AI SDK message and content shapes to the OpenTelemetry
 * GenAI semantic-convention "parts" format used by `gen_ai.input.messages`,
 * `gen_ai.output.messages`, and `gen_ai.system_instructions`.
 *
 * Grafana Agent Observability parses only this format; AI SDK shapes show up
 * there as roles without content. Binary payloads (file and image bytes) are
 * never exported, only their media type.
 */

export type GenAiPart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_call_response'; id: string; response: unknown }
  | { type: 'blob'; modality: string; mime_type: string }
  | { type: string };

export interface GenAiMessage {
  role: string;
  parts: GenAiPart[];
  finish_reason?: string;
}

/** Serialized size budget for one content attribute (512 KiB). */
export const GENAI_CONTENT_BUDGET_BYTES = 512 * 1024;

const TRUNCATION_MARKER = '…[truncated]';
const MAX_TRUNCATION_ROUNDS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function modalityOf(mediaType: string): string {
  const topLevel = mediaType.split('/')[0]?.toLowerCase() ?? '';
  return topLevel === '' ? 'unknown' : topLevel;
}

function blobPart(mediaType: unknown): GenAiPart {
  const mime = typeof mediaType === 'string' ? mediaType : '';
  return { type: 'blob', modality: modalityOf(mime), mime_type: mime };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Maps an AI SDK `ToolResultOutput` to a GenAI `tool_call_response` value. */
function toolResultResponse(output: unknown): unknown {
  if (!isRecord(output)) return output;
  switch (output.type) {
    case 'text':
    case 'error-text':
    case 'json':
    case 'error-json':
      return output.value;
    case 'execution-denied': {
      const reason = stringField(output, 'reason');
      return reason ? `Execution denied: ${reason}` : 'Execution denied';
    }
    case 'content':
      return Array.isArray(output.value)
        ? output.value.map((entry) => toGenAiPart(entry))
        : [];
    default:
      return output;
  }
}

/**
 * Maps one AI SDK part (prompt part, tool-result content entry, or
 * generated `ContentPart`) to a GenAI part. Unknown parts keep only their
 * type, so new SDK part kinds never leak unreviewed payloads.
 */
export function toGenAiPart(part: unknown): GenAiPart {
  if (typeof part === 'string') return { type: 'text', content: part };
  if (!isRecord(part)) return { type: 'unknown' };
  const type = typeof part.type === 'string' ? part.type : 'unknown';
  switch (type) {
    case 'text':
      return { type: 'text', content: stringField(part, 'text') };
    case 'reasoning':
      return { type: 'reasoning', content: stringField(part, 'text') };
    case 'tool-call':
      return {
        type: 'tool_call',
        id: stringField(part, 'toolCallId'),
        name: stringField(part, 'toolName'),
        arguments: part.input,
      };
    case 'tool-result':
      return {
        type: 'tool_call_response',
        id: stringField(part, 'toolCallId'),
        response: toolResultResponse(part.output),
      };
    case 'tool-error':
      return {
        type: 'tool_call_response',
        id: stringField(part, 'toolCallId'),
        response: errorText(part.error),
      };
    case 'image':
    case 'file-data':
    case 'image-data':
      return blobPart(part.mediaType);
    case 'file':
    case 'reasoning-file': {
      // Generated content parts carry the file under `file`.
      const generated = isRecord(part.file) ? part.file : undefined;
      return blobPart(generated?.mediaType ?? part.mediaType);
    }
    default:
      return { type };
  }
}

function contentToParts(content: unknown): GenAiPart[] {
  if (typeof content === 'string') return [{ type: 'text', content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => toGenAiPart(part));
}

export function toGenAiInputMessages(
  messages: readonly ModelMessage[],
): GenAiMessage[] {
  return messages.map((message) => ({
    role: message.role,
    parts: contentToParts(message.content),
  }));
}

/** Output of a finished generation: one assistant message. */
export function toGenAiOutputMessages(
  content: readonly unknown[],
  finishReason: string | undefined,
): GenAiMessage[] {
  const message: GenAiMessage = {
    role: 'assistant',
    parts: contentToParts(content),
  };
  if (finishReason) message.finish_reason = finishReason;
  return [message];
}

/** Output of an aborted generation: one assistant message per completed step. */
export function toGenAiOutputMessagesFromSteps(
  steps: readonly { readonly content: readonly unknown[] }[],
): GenAiMessage[] {
  return steps.map((step, index) => {
    const message: GenAiMessage = {
      role: 'assistant',
      parts: contentToParts(step.content),
    };
    if (index === steps.length - 1) message.finish_reason = 'aborted';
    return message;
  });
}

export function toGenAiSystemInstructions(
  instructions: Instructions | undefined,
): GenAiPart[] | undefined {
  if (instructions == null) return undefined;
  if (typeof instructions === 'string') {
    return [{ type: 'text', content: instructions }];
  }
  const list = Array.isArray(instructions) ? instructions : [instructions];
  const parts: GenAiPart[] = list.map((message) => ({
    type: 'text',
    content: message.content,
  }));
  return parts.length > 0 ? parts : undefined;
}

export interface BudgetedJson {
  json: string;
  /** Oldest messages removed to fit the budget. */
  droppedMessages: number;
  /** True when part payloads were shortened to fit the budget. */
  truncated: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Deep copy through JSON, matching exactly what is exported. */
function jsonClone<T>(value: T): T | undefined {
  const json = safeStringify(value);
  return json === undefined ? undefined : (JSON.parse(json) as T);
}

/** Payload field of a part that may be shortened, if any. */
function payloadKey(part: GenAiPart): 'content' | 'arguments' | 'response' {
  if (part.type === 'tool_call') return 'arguments';
  if (part.type === 'tool_call_response') return 'response';
  return 'content';
}

/**
 * Shortens the largest part payload until `items` serializes within `budget`.
 * Non-string payloads are first replaced by their JSON text so they can be
 * shortened like strings. Mutates `items`.
 */
function truncateToBudget(items: unknown[], budget: number): boolean {
  let truncated = false;
  for (let round = 0; round < MAX_TRUNCATION_ROUNDS; round++) {
    const json = safeStringify(items) ?? '';
    const excess = byteLength(json) - budget;
    if (excess <= 0) return truncated;

    let largest: { record: Record<string, unknown>; key: string } | undefined;
    let largestSize = -1;
    for (const item of items) {
      const parts =
        isRecord(item) && Array.isArray(item.parts) ? item.parts : [item];
      for (const part of parts) {
        if (!isRecord(part)) continue;
        const key = payloadKey(part as GenAiPart);
        if (!(key in part)) continue;
        const value = part[key];
        const size =
          typeof value === 'string'
            ? value.length
            : (safeStringify(value)?.length ?? 0);
        if (size > largestSize) {
          largestSize = size;
          largest = { record: part, key };
        }
      }
    }
    if (!largest || largestSize <= TRUNCATION_MARKER.length) return truncated;

    const current = largest.record[largest.key];
    const text =
      typeof current === 'string' ? current : (safeStringify(current) ?? '');
    // Removing N UTF-16 units removes at least N UTF-8 bytes.
    const keep = Math.max(0, text.length - excess - TRUNCATION_MARKER.length);
    largest.record[largest.key] = `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
    truncated = true;
  }
  return truncated;
}

/**
 * Serializes GenAI messages within `budget` bytes. Oldest messages are
 * dropped first (the last message is always kept); if that is not enough,
 * part payloads are shortened. The result is always valid JSON.
 */
export function serializeMessagesWithBudget(
  messages: readonly GenAiMessage[],
  budget = GENAI_CONTENT_BUDGET_BYTES,
): BudgetedJson | undefined {
  const sizes = messages.map((message) =>
    byteLength(safeStringify(message) ?? ''),
  );
  // Array brackets plus one comma between entries.
  let total = 2 + sizes.reduce((sum, size) => sum + size, 0);
  total += Math.max(0, messages.length - 1);
  let start = 0;
  while (total > budget && start < messages.length - 1) {
    total -= (sizes[start] ?? 0) + 1;
    start++;
  }
  const kept = jsonClone(messages.slice(start));
  if (kept === undefined) return undefined;
  const truncated = truncateToBudget(kept, budget);
  const json = safeStringify(kept);
  if (json === undefined) return undefined;
  return { json, droppedMessages: start, truncated };
}

/** Serializes a part list (system instructions) within `budget` bytes. */
export function serializePartsWithBudget(
  parts: readonly GenAiPart[],
  budget = GENAI_CONTENT_BUDGET_BYTES,
): BudgetedJson | undefined {
  const kept = jsonClone([...parts]);
  if (kept === undefined) return undefined;
  const truncated = truncateToBudget(kept, budget);
  const json = safeStringify(kept);
  if (json === undefined) return undefined;
  return { json, droppedMessages: 0, truncated };
}
