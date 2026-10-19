/**
 * Size bounds for GenAI content attributes (`gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`) at export time.
 *
 * `@ai-sdk/otel` serializes full conversations without a limit. Exported
 * values must stay valid JSON, so oversized documents are reduced
 * structurally: the oldest input messages are dropped first (the last
 * message is always kept), then the largest part payloads are shortened.
 */

/** Serialized size budget for one content attribute (512 KiB). */
export const GENAI_CONTENT_BUDGET_BYTES = 512 * 1024;

const TRUNCATION_MARKER = '…[truncated]';
const MAX_TRUNCATION_ROUNDS = 32;

const MESSAGE_ATTRIBUTES = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
]);
const BUDGETED_ATTRIBUTES = new Set([
  ...MESSAGE_ATTRIBUTES,
  'gen_ai.system_instructions',
]);

export interface BudgetedContent {
  json: string;
  droppedMessages: number;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Payload field of a part that may be shortened. */
function payloadKey(part: Record<string, unknown>): string {
  if (part.type === 'tool_call') return 'arguments';
  if (part.type === 'tool_call_response') return 'response';
  if (part.type === 'uri') return 'uri';
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
    const excess = byteLength(safeStringify(items) ?? '') - budget;
    if (excess <= 0) return truncated;

    let largest: { record: Record<string, unknown>; key: string } | undefined;
    let largestSize = -1;
    for (const item of items) {
      const parts =
        isRecord(item) && Array.isArray(item.parts) ? item.parts : [item];
      for (const part of parts) {
        if (!isRecord(part)) continue;
        const key = payloadKey(part);
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

function dropOldest(items: unknown[], budget: number): number {
  const sizes = items.map((item) => byteLength(safeStringify(item) ?? ''));
  // Array brackets plus one comma between entries.
  let total = 2 + sizes.reduce((sum, size) => sum + size, 0);
  total += Math.max(0, items.length - 1);
  let start = 0;
  while (total > budget && start < items.length - 1) {
    total -= (sizes[start] ?? 0) + 1;
    start++;
  }
  items.splice(0, start);
  return start;
}

export function isBudgetedGenAiAttribute(key: string): boolean {
  return BUDGETED_ATTRIBUTES.has(key);
}

/**
 * Bounds a parsed content document to `budget` serialized bytes. Mutates
 * `document`. Returns undefined when the document cannot be serialized.
 */
export function boundGenAiContent(
  key: string,
  document: unknown,
  budget = GENAI_CONTENT_BUDGET_BYTES,
): BudgetedContent | undefined {
  const json = safeStringify(document);
  if (json === undefined) return undefined;
  if (byteLength(json) <= budget || !Array.isArray(document)) {
    return { json, droppedMessages: 0, truncated: false };
  }
  const droppedMessages =
    key === 'gen_ai.input.messages' ? dropOldest(document, budget) : 0;
  const truncated = truncateToBudget(document, budget);
  const bounded = safeStringify(document);
  if (bounded === undefined) return undefined;
  return { json: bounded, droppedMessages, truncated };
}
