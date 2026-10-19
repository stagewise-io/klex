/**
 * Size bounds for GenAI content attributes (`gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`,
 * `gen_ai.tool.definitions`) at export time.
 *
 * `@ai-sdk/otel` serializes full conversations without a limit. Exported
 * values must stay valid JSON, so oversized documents are reduced
 * structurally: the oldest input messages are dropped first (the last
 * message is always kept), then the largest part payloads are shortened,
 * then the largest remaining strings. A document that still does not fit is
 * replaced by an empty placeholder, so the budget always holds.
 */

/** Serialized size budget for one content attribute (512 KiB). */
export const GENAI_CONTENT_BUDGET_BYTES = 512 * 1024;

const TRUNCATION_MARKER = '…[truncated]';
const MAX_TRUNCATION_ROUNDS = 32;
const MAX_WALK_DEPTH = 64;

const BUDGETED_ATTRIBUTES = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
]);

export interface BudgetedContent {
  json: string;
  droppedMessages: number;
  truncated: boolean;
}

type Holder = Record<string, unknown> | unknown[];

/** A shortenable value: `holder[key]`, `size` UTF-8 bytes long. */
interface Slot {
  holder: Holder;
  key: string | number;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

const MARKER_BYTES = byteLength(TRUNCATION_MARKER);

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function serializedBytes(value: unknown): number {
  return byteLength(safeStringify(value) ?? '');
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, on a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) to a code point boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/** Payload field of a part that may be shortened. */
function payloadKey(part: Record<string, unknown>): string {
  if (part.type === 'tool_call') return 'arguments';
  if (part.type === 'tool_call_response') return 'response';
  if (part.type === 'uri') return 'uri';
  return 'content';
}

function pickLarger(best: Slot | undefined, candidate: Slot): Slot {
  return best === undefined || candidate.size > best.size ? candidate : best;
}

/** Largest message-part payload, the preferred truncation target. */
function largestPartPayload(document: unknown): Slot | undefined {
  if (!Array.isArray(document)) return undefined;
  let best: Slot | undefined;
  for (const item of document) {
    const parts =
      isRecord(item) && Array.isArray(item.parts) ? item.parts : [item];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const key = payloadKey(part);
      if (!(key in part)) continue;
      const value = part[key];
      const size =
        typeof value === 'string' ? byteLength(value) : serializedBytes(value);
      best = pickLarger(best, { holder: part, key, size });
    }
  }
  return best;
}

/** Largest string anywhere in the document (fallback target). */
function largestStringLeaf(
  holder: Holder,
  key: string | number,
  depth: number,
  best: Slot | undefined,
): Slot | undefined {
  const value = (holder as Record<string | number, unknown>)[key];
  if (typeof value === 'string') {
    return pickLarger(best, { holder, key, size: byteLength(value) });
  }
  if (depth >= MAX_WALK_DEPTH || typeof value !== 'object' || value === null) {
    return best;
  }
  let result = best;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      result = largestStringLeaf(value, index, depth + 1, result);
    }
  } else {
    for (const childKey of Object.keys(value)) {
      result = largestStringLeaf(
        value as Record<string, unknown>,
        childKey,
        depth + 1,
        result,
      );
    }
  }
  return result;
}

/**
 * Shortens the largest part payload (or, failing that, the largest string)
 * until `root.value` serializes within `budget`. Non-string payloads are
 * replaced by their JSON text so they can be shortened like strings.
 * Mutates the document.
 */
function truncateToBudget(root: { value: unknown }, budget: number): boolean {
  let truncated = false;
  for (let round = 0; round < MAX_TRUNCATION_ROUNDS; round++) {
    const excess = serializedBytes(root.value) - budget;
    if (excess <= 0) return truncated;

    let slot = largestPartPayload(root.value);
    if (!slot || slot.size <= MARKER_BYTES) {
      slot = largestStringLeaf(root, 'value', 0, undefined);
    }
    if (!slot || slot.size <= MARKER_BYTES) return truncated;

    const holder = slot.holder as Record<string | number, unknown>;
    const current = holder[slot.key];
    const text =
      typeof current === 'string' ? current : (safeStringify(current) ?? '');
    // Each raw UTF-8 byte removed removes at least one serialized byte.
    const keep = byteLength(text) - excess - MARKER_BYTES;
    holder[slot.key] = `${truncateUtf8(text, keep)}${TRUNCATION_MARKER}`;
    truncated = true;
  }
  return truncated;
}

function dropOldest(items: unknown[], budget: number): number {
  const sizes = items.map((item) => serializedBytes(item));
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
  if (byteLength(json) <= budget) {
    return { json, droppedMessages: 0, truncated: false };
  }
  const droppedMessages =
    key === 'gen_ai.input.messages' && Array.isArray(document)
      ? dropOldest(document, budget)
      : 0;
  const root = { value: document };
  const truncated = truncateToBudget(root, budget);
  const bounded = safeStringify(root.value);
  if (bounded === undefined) return undefined;
  if (byteLength(bounded) <= budget) {
    return { json: bounded, droppedMessages, truncated };
  }
  // Nothing left to shorten (e.g. very many tiny parts): keep the attribute
  // valid and flagged rather than exporting a value the backend would drop.
  const placeholder = Array.isArray(document)
    ? '[]'
    : JSON.stringify(TRUNCATION_MARKER);
  return { json: placeholder, droppedMessages, truncated: true };
}
