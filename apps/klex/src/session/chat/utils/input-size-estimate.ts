import { createHash } from 'node:crypto';

import { asSchema, type FlexibleSchema, type ModelMessage } from 'ai';

import { countO200kBaseUnits } from '@/session/tokenizer';

import type { AgentTools } from '../tools';

/**
 * Content-free estimates for the text components Klex gives the model. Values
 * use o200k_base units, not provider-reported tokens. Prompt values are read
 * only in memory; this module returns numeric aggregates, never prompt text.
 */
export interface InputSizeEstimate {
  readonly attributes: Readonly<Record<string, number>>;
}

type HistoryBucket =
  | 'history.user_text'
  | 'history.assistant_text'
  | 'history.system_text'
  | 'history.call_payload'
  | 'history.result_payload'
  | 'history.memory_text'
  | 'history.other';
type StructuredKind = 'identifier' | 'filepath' | 'url';

const MIN_REPEAT_LINE_CODE_POINTS = 32;
const MAX_REPEAT_LINES = 50_000;
const MAX_STRUCTURED_CANDIDATES = 50_000;
const MAX_STRUCTURED_CANDIDATE_LENGTH = 4_096;
const MAX_STRUCTURED_CANDIDATE_CHARS = 1_000_000;

const URL_PATTERN = /\b(?:https?|file):\/\/[^\s<>"'\x60)}\]]+/giu;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const HEX_IDENTIFIER_PATTERN = /^[0-9a-f]{16,}$/iu;
const IDENTIFIER_PATTERN =
  /\b(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,})\b/giu;
const MEMORY_BLOCK_PATTERN = /<memory>\s*[\s\S]*?<\/memory>/giu;

const OUTPUT_KEYS = {
  estimatorVersion: 'klex.input_size.estimator_version',
  baseInstructions: 'klex.input_size.base_instruction_units',
  extensionInstructions: 'klex.input_size.extension_instruction_units',
  userText: 'klex.input_size.history_incoming_text_units',
  assistantText: 'klex.input_size.history_assistant_text_units',
  systemText: 'klex.input_size.history_instruction_role_units',
  callPayload: 'klex.input_size.history_call_payload_units',
  resultPayload: 'klex.input_size.history_result_payload_units',
  memoryText: 'klex.input_size.history_memory_text_units',
  otherHistory: 'klex.input_size.history_other_units',
  toolSchema: 'klex.input_size.tool_schema_units',
  total: 'klex.input_size.estimated_total_units',
  identifierShare: 'klex.input_size.identifier_share',
  filepathShare: 'klex.input_size.filepath_share',
  urlShare: 'klex.input_size.url_share',
  identifier: 'klex.input_size.identifier_units',
  filepath: 'klex.input_size.filepath_units',
  url: 'klex.input_size.url_units',
  repeatIdentifier: 'klex.input_size.repeated_identifier_units',
  repeatFilepath: 'klex.input_size.repeated_filepath_units',
  repeatUrl: 'klex.input_size.repeated_url_units',
  repeatLine: 'klex.input_size.repeated_line_units',
  repeatIdentifierCount: 'klex.input_size.repeated_identifier_occurrence_count',
  repeatFilepathCount: 'klex.input_size.repeated_filepath_occurrence_count',
  repeatUrlCount: 'klex.input_size.repeated_url_occurrence_count',
  repeatLineCount: 'klex.input_size.repeated_line_occurrence_count',
  historyItems: 'klex.input_size.history_item_count',
  toolCount: 'klex.input_size.tool_count',
  imageParts: 'klex.input_size.image_part_count',
  fileParts: 'klex.input_size.file_part_count',
  structuredScanTruncated: 'klex.input_size.structured_scan_truncated',
  repeatedLineScanTruncated: 'klex.input_size.repeated_line_scan_truncated',
  unestimatedComponentCount: 'klex.input_size.unestimated_tool_component_count',
} as const;

/**
 * Estimates a single assembled request. Structured-content and repetition
 * fields are sub-breakdowns of the component totals, not extra input units.
 */
export function estimateInputSize(input: {
  readonly basePrompt: string;
  readonly extensionSystemPromptParts: readonly string[];
  readonly modelMessages: readonly ModelMessage[];
  readonly tools: AgentTools;
}): InputSizeEstimate {
  const state = createState();
  addText(state, 'base_instruction', input.basePrompt);
  for (const part of input.extensionSystemPromptParts)
    addText(state, 'extension_instruction', part);

  for (const message of input.modelMessages) addMessage(state, message);
  addToolDefinitions(state, input.tools);

  const total =
    state.units.base_instruction +
    state.units.extension_instruction +
    Object.values(state.historyUnits).reduce((sum, value) => sum + value, 0) +
    state.units.tool_schema;
  const attributes: Record<string, number> = {
    [OUTPUT_KEYS.estimatorVersion]: 1,
    [OUTPUT_KEYS.baseInstructions]: state.units.base_instruction,
    [OUTPUT_KEYS.extensionInstructions]: state.units.extension_instruction,
    [OUTPUT_KEYS.userText]: state.historyUnits['history.user_text'],
    [OUTPUT_KEYS.assistantText]: state.historyUnits['history.assistant_text'],
    [OUTPUT_KEYS.systemText]: state.historyUnits['history.system_text'],
    [OUTPUT_KEYS.callPayload]: state.historyUnits['history.call_payload'],
    [OUTPUT_KEYS.resultPayload]: state.historyUnits['history.result_payload'],
    [OUTPUT_KEYS.memoryText]: state.historyUnits['history.memory_text'],
    [OUTPUT_KEYS.otherHistory]: state.historyUnits['history.other'],
    [OUTPUT_KEYS.toolSchema]: state.units.tool_schema,
    [OUTPUT_KEYS.total]: total,
    [OUTPUT_KEYS.identifierShare]: estimatedShare(
      state.structuredUnits.identifier,
      total,
    ),
    [OUTPUT_KEYS.filepathShare]: estimatedShare(
      state.structuredUnits.filepath,
      total,
    ),
    [OUTPUT_KEYS.urlShare]: estimatedShare(state.structuredUnits.url, total),
    [OUTPUT_KEYS.identifier]: state.structuredUnits.identifier,
    [OUTPUT_KEYS.filepath]: state.structuredUnits.filepath,
    [OUTPUT_KEYS.url]: state.structuredUnits.url,
    [OUTPUT_KEYS.repeatIdentifier]: state.repeatedUnits.identifier,
    [OUTPUT_KEYS.repeatFilepath]: state.repeatedUnits.filepath,
    [OUTPUT_KEYS.repeatUrl]: state.repeatedUnits.url,
    [OUTPUT_KEYS.repeatLine]: state.repeatedLineUnits,
    [OUTPUT_KEYS.repeatIdentifierCount]: state.repeatedOccurrences.identifier,
    [OUTPUT_KEYS.repeatFilepathCount]: state.repeatedOccurrences.filepath,
    [OUTPUT_KEYS.repeatUrlCount]: state.repeatedOccurrences.url,
    [OUTPUT_KEYS.repeatLineCount]: state.repeatedLineOccurrences,
    [OUTPUT_KEYS.historyItems]: input.modelMessages.length,
    [OUTPUT_KEYS.toolCount]: Object.keys(input.tools).length,
    [OUTPUT_KEYS.imageParts]: state.imagePartCount,
    [OUTPUT_KEYS.fileParts]: state.filePartCount,
    [OUTPUT_KEYS.structuredScanTruncated]: Number(
      state.structuredScanTruncated,
    ),
    [OUTPUT_KEYS.repeatedLineScanTruncated]: Number(
      state.repeatedLineScanTruncated,
    ),
    [OUTPUT_KEYS.unestimatedComponentCount]:
      state.unestimatedToolComponentCount,
  };
  return { attributes };
}

interface EstimateState {
  units: {
    base_instruction: number;
    extension_instruction: number;
    tool_schema: number;
  };
  historyUnits: Record<HistoryBucket, number>;
  structuredUnits: Record<StructuredKind, number>;
  repeatedUnits: Record<StructuredKind, number>;
  repeatedOccurrences: Record<StructuredKind, number>;
  repeatedLineOccurrences: number;
  repeatedContentCounts: Map<string, number>;
  repeatedLineUnits: number;
  repeatedLineCount: number;
  imagePartCount: number;
  filePartCount: number;
  unestimatedToolComponentCount: number;
  structuredCandidateCount: number;
  structuredCandidateChars: number;
  structuredScanTruncated: boolean;
  structuredScanBudgetExhausted: boolean;
  repeatedLineScanTruncated: boolean;
}

function createState(): EstimateState {
  return {
    units: { base_instruction: 0, extension_instruction: 0, tool_schema: 0 },
    historyUnits: {
      'history.user_text': 0,
      'history.assistant_text': 0,
      'history.system_text': 0,
      'history.call_payload': 0,
      'history.result_payload': 0,
      'history.memory_text': 0,
      'history.other': 0,
    },
    structuredUnits: { identifier: 0, filepath: 0, url: 0 },
    repeatedUnits: { identifier: 0, filepath: 0, url: 0 },
    repeatedOccurrences: { identifier: 0, filepath: 0, url: 0 },
    repeatedLineOccurrences: 0,
    repeatedContentCounts: new Map(),
    repeatedLineUnits: 0,
    repeatedLineCount: 0,
    imagePartCount: 0,
    filePartCount: 0,
    unestimatedToolComponentCount: 0,
    structuredCandidateCount: 0,
    structuredCandidateChars: 0,
    structuredScanTruncated: false,
    structuredScanBudgetExhausted: false,
    repeatedLineScanTruncated: false,
  };
}

function addMessage(state: EstimateState, message: ModelMessage): void {
  if (typeof message.content === 'string') {
    addRoleText(state, message.role, message.content);
    return;
  }

  for (const part of message.content) {
    const candidate = part as unknown as Record<string, unknown>;
    switch (candidate.type) {
      case 'text':
      case 'reasoning':
        if (typeof candidate.text === 'string')
          addRoleText(state, message.role, candidate.text);
        break;
      case 'tool-call':
        addHistoryText(
          state,
          'history.call_payload',
          stringify({
            toolName: candidate.toolName,
            toolCallId: candidate.toolCallId,
            input: candidate.input,
          }),
        );
        break;
      case 'tool-result':
        addHistoryText(
          state,
          'history.result_payload',
          stringify({
            toolName: candidate.toolName,
            toolCallId: candidate.toolCallId,
            output: candidate.output,
          }),
        );
        break;
      case 'image':
        state.imagePartCount += 1;
        break;
      case 'file':
        state.filePartCount += 1;
        break;
      default:
        if (typeof candidate.text === 'string')
          addRoleText(state, message.role, candidate.text);
        else if (candidate.type === 'tool-approval-response')
          addHistoryText(
            state,
            'history.other',
            stringify({
              approvalId: candidate.approvalId,
              approved: candidate.approved,
              reason: candidate.reason,
            }),
          );
    }
  }
}

function addRoleText(
  state: EstimateState,
  role: ModelMessage['role'],
  text: string,
): void {
  if (role === 'user') {
    addUserTextAndMemory(state, text);
  } else if (role === 'assistant') {
    addHistoryText(state, 'history.assistant_text', text);
  } else if (role === 'system') {
    addHistoryText(state, 'history.system_text', text);
  } else {
    addHistoryText(state, 'history.result_payload', text);
  }
}

function addUserTextAndMemory(state: EstimateState, text: string): void {
  let offset = 0;
  for (const match of text.matchAll(MEMORY_BLOCK_PATTERN)) {
    const start = match.index;
    const block = match[0];
    addHistoryText(state, 'history.user_text', text.slice(offset, start));
    addHistoryText(state, 'history.memory_text', block);
    offset = start + block.length;
  }
  addHistoryText(state, 'history.user_text', text.slice(offset));
}

function addHistoryText(
  state: EstimateState,
  bucket: HistoryBucket,
  text: string | undefined,
): void {
  if (!text) return;
  const units = countO200kBaseUnits(text);
  state.historyUnits[bucket] += units;
  recordStructuredContent(state, text);
  recordRepeatedLines(state, text);
}

function addText(
  state: EstimateState,
  bucket: 'base_instruction' | 'extension_instruction',
  text: string,
): void {
  if (!text) return;
  state.units[bucket] += countO200kBaseUnits(text);
  recordStructuredContent(state, text);
  recordRepeatedLines(state, text);
}

function addToolDefinitions(state: EstimateState, tools: AgentTools): void {
  for (const [name, tool] of Object.entries(tools)) {
    const description =
      typeof tool.description === 'string' ? tool.description : undefined;
    if (typeof tool.description === 'function')
      state.unestimatedToolComponentCount += 1;
    const schema = getToolInputJsonSchema(tool.inputSchema);
    if (schema === undefined) state.unestimatedToolComponentCount += 1;
    const serializedSchema = stringify(schema);
    state.units.tool_schema += countO200kBaseUnits(
      `${name}\n${description ?? ''}\n${serializedSchema ?? ''}`,
    );
    recordStructuredContent(state, name);
    if (description) {
      recordStructuredContent(state, description);
      recordRepeatedLines(state, description);
    }
    if (serializedSchema) {
      recordStructuredContent(state, serializedSchema);
      recordRepeatedLines(state, serializedSchema);
    }
  }
}

function getToolInputJsonSchema(inputSchema: unknown): unknown | undefined {
  if (inputSchema === undefined)
    return { type: 'object', properties: {}, additionalProperties: false };
  if (typeof inputSchema === 'function') {
    try {
      return getToolInputJsonSchema(inputSchema());
    } catch {
      return undefined;
    }
  }
  if (!isRecord(inputSchema)) return undefined;

  // Zod/Standard Schema objects can expose a type field; convert them first.
  if ('jsonSchema' in inputSchema)
    return resolveSchemaValue(inputSchema.jsonSchema);
  if (
    '~standard' in inputSchema ||
    '_zod' in inputSchema ||
    '_def' in inputSchema
  ) {
    try {
      const converted = asSchema(inputSchema as FlexibleSchema)
        .jsonSchema as unknown;
      return resolveSchemaValue(converted);
    } catch {
      return undefined;
    }
  }

  // Raw JSON Schemas (including MCP descriptors) are already provider-facing.
  if (
    'type' in inputSchema ||
    Object.keys(inputSchema).some((key) => key.startsWith('$'))
  ) {
    return inputSchema;
  }
  return undefined;
}

function resolveSchemaValue(value: unknown): unknown | undefined {
  try {
    const resolved = typeof value === 'function' ? value() : value;
    if (isPromiseLike(resolved)) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === 'function';
}

interface StructuredCandidate {
  readonly start: number;
  readonly end: number;
  readonly kind: StructuredKind;
  readonly value: string;
}

// Keep path/ID scans linear; avoid unanchored backtracking over prompt text.
function recordStructuredContent(state: EstimateState, text: string): void {
  if (state.structuredScanBudgetExhausted) return;
  const candidates: StructuredCandidate[] = [];
  collectUrlCandidates(state, text, candidates);
  if (state.structuredCandidateCount >= MAX_STRUCTURED_CANDIDATES) {
    state.structuredScanTruncated = true;
    state.structuredScanBudgetExhausted = true;
  }
  if (!state.structuredScanBudgetExhausted)
    collectFilepathCandidates(state, text, candidates);
  if (state.structuredCandidateCount >= MAX_STRUCTURED_CANDIDATES) {
    state.structuredScanTruncated = true;
    state.structuredScanBudgetExhausted = true;
  }
  if (!state.structuredScanBudgetExhausted)
    collectIdentifierCandidates(state, text, candidates);
  if (state.structuredCandidateCount >= MAX_STRUCTURED_CANDIDATES) {
    state.structuredScanTruncated = true;
    state.structuredScanBudgetExhausted = true;
  }

  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      structuredPriority(left.kind) - structuredPriority(right.kind) ||
      right.end - left.end,
  );
  let occupiedUntil = -1;
  for (const candidate of candidates) {
    if (candidate.start < occupiedUntil) continue;
    occupiedUntil = candidate.end;
    const units = countO200kBaseUnits(candidate.value);
    state.structuredUnits[candidate.kind] += units;
    const duplicateKey = createHash('sha256')
      .update(candidate.kind)
      .update(':')
      .update(
        candidate.kind === 'identifier'
          ? candidate.value.toLowerCase()
          : candidate.value,
      )
      .digest('hex');
    const priorCount = state.repeatedContentCounts.get(duplicateKey) ?? 0;
    if (priorCount > 0) {
      state.repeatedUnits[candidate.kind] += units;
      state.repeatedOccurrences[candidate.kind] += 1;
    }
    state.repeatedContentCounts.set(duplicateKey, priorCount + 1);
  }
}

function collectUrlCandidates(
  state: EstimateState,
  text: string,
  candidates: StructuredCandidate[],
): void {
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    let end = start + match[0].length;
    while (end > start) {
      const trailing = text[end - 1];
      if (trailing === undefined || !'.,!?;:'.includes(trailing)) break;
      end -= 1;
    }
    if (!addStructuredCandidate(state, text, start, end, 'url', candidates))
      return;
  }
}

function collectFilepathCandidates(
  state: EstimateState,
  text: string,
  candidates: StructuredCandidate[],
): void {
  let cursor = 0;
  while (cursor < text.length) {
    if (!isPathTokenChar(text[cursor])) {
      cursor += 1;
      continue;
    }
    const runStart = cursor;
    while (cursor < text.length && isPathTokenChar(text[cursor])) cursor += 1;
    collectPathsInRun(state, text, runStart, cursor, candidates);
    if (state.structuredCandidateCount >= MAX_STRUCTURED_CANDIDATES) {
      state.structuredScanTruncated = true;
      return;
    }
  }
}

function collectPathsInRun(
  state: EstimateState,
  text: string,
  runStart: number,
  runEnd: number,
  candidates: StructuredCandidate[],
): void {
  let sequenceStart = -1;
  let segmentCount = 0;
  let segmentStart = runStart;

  for (let index = runStart; index <= runEnd; index += 1) {
    if (index < runEnd && text[index] !== '/') continue;

    if (segmentStart < index) {
      if (segmentCount === 0)
        sequenceStart =
          segmentStart === runStart + 1 && text[runStart] === '/'
            ? runStart
            : segmentStart;
      segmentCount += 1;
    } else if (index !== runStart) {
      if (segmentCount >= 2) {
        if (
          !addStructuredCandidate(
            state,
            text,
            sequenceStart,
            index,
            'filepath',
            candidates,
          )
        )
          return;
      }
      sequenceStart = -1;
      segmentCount = 0;
    }

    if (index === runEnd || index + 1 === runEnd || text[index + 1] === '/') {
      if (segmentCount >= 2) {
        if (
          !addStructuredCandidate(
            state,
            text,
            sequenceStart,
            index,
            'filepath',
            candidates,
          )
        )
          return;
      }
      sequenceStart = -1;
      segmentCount = 0;
    }
    segmentStart = index + 1;
  }
}

// No lookaheads: candidates consume whole word-like runs and are filtered after.
function collectIdentifierCandidates(
  state: EstimateState,
  text: string,
  candidates: StructuredCandidate[],
): void {
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const value = match[0];
    const isUuid = UUID_PATTERN.test(value);
    const isLongHex = HEX_IDENTIFIER_PATTERN.test(value);
    const isMixedIdentifier = /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);
    if (!isUuid && !isLongHex && !isMixedIdentifier) continue;
    if (
      !addStructuredCandidate(
        state,
        text,
        match.index,
        match.index + value.length,
        'identifier',
        candidates,
      )
    )
      return;
  }
}

function addStructuredCandidate(
  state: EstimateState,
  text: string,
  start: number,
  end: number,
  kind: StructuredKind,
  candidates: StructuredCandidate[],
): boolean {
  if (state.structuredCandidateCount >= MAX_STRUCTURED_CANDIDATES) {
    state.structuredScanTruncated = true;
    state.structuredScanBudgetExhausted = true;
    return false;
  }
  state.structuredCandidateCount += 1;
  const length = end - start;
  if (length > MAX_STRUCTURED_CANDIDATE_LENGTH) {
    // Skip one oversized candidate, but keep collecting later content.
    state.structuredScanTruncated = true;
    return true;
  }
  if (
    state.structuredCandidateChars + length >
    MAX_STRUCTURED_CANDIDATE_CHARS
  ) {
    state.structuredScanTruncated = true;
    state.structuredScanBudgetExhausted = true;
    return false;
  }
  state.structuredCandidateChars += length;
  candidates.push({ start, end, kind, value: text.slice(start, end) });
  return true;
}

function isPathTokenChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    isAsciiLetterCode(code) ||
    (code >= 48 && code <= 57) ||
    char === '_' ||
    char === '.' ||
    char === '-' ||
    char === '/' ||
    char === '~' ||
    char === ':'
  );
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function structuredPriority(kind: StructuredKind): number {
  if (kind === 'url') return 0;
  if (kind === 'filepath') return 1;
  return 2;
}

function recordRepeatedLines(state: EstimateState, text: string): void {
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf(String.fromCharCode(10), offset);
    const end = newline === -1 ? text.length : newline;
    const normalized = text.slice(offset, end).trim();
    if (countCodePoints(normalized) >= MIN_REPEAT_LINE_CODE_POINTS) {
      if (state.repeatedLineCount >= MAX_REPEAT_LINES) {
        state.repeatedLineScanTruncated = true;
        return;
      }
      state.repeatedLineCount += 1;
      const digest = createHash('sha256').update(normalized).digest('hex');
      const key = `line:${digest}`;
      const priorCount = state.repeatedContentCounts.get(key) ?? 0;
      if (priorCount > 0) {
        state.repeatedLineUnits += countO200kBaseUnits(normalized);
        state.repeatedLineOccurrences += 1;
      }
      state.repeatedContentCounts.set(key, priorCount + 1);
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _point of value) count += 1;
  return count;
}

function stringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function estimatedShare(part: number, total: number): number {
  return total === 0 ? 0 : Math.min(part / total, 1);
}
