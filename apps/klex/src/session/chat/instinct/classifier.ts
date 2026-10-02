import z from 'zod';

import type {
  InstinctClassificationKey,
  InstinctClassificationOutcome,
  InstinctClassificationRequest,
} from '@/session/chat/extensions/extension-api';
import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';

import classifierBasePrompt from './classifier-prompt.md';

export const INSTINCT_CLASSIFIER_LIMITS = {
  maxKeysPerRequest: 16,
  maxEnumValues: 32,
  maxEnumValueLength: 64,
  maxDescriptionLength: 500,
  maxPromptLength: 4_000,
} as const;

const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** One validated participant of a classifier call. */
export interface InstinctClassifierEntry {
  readonly extensionIdentifier: string;
  /** JSON-safe, unique property name for this extension's answer slice. */
  readonly outputKey: string;
  readonly request: InstinctClassificationRequest;
}

/**
 * Result of the structured model call. `partial` carries raw text when the
 * SDK could not produce a fully valid object; valid slices are salvaged
 * from it.
 */
export type InstinctStructuredGenerationResult =
  | {
      readonly status: 'ok';
      readonly output: unknown;
      readonly modelId: string;
    }
  | {
      readonly status: 'partial';
      readonly text: string | undefined;
      readonly modelId: string;
    }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export interface InstinctStructuredGenerationArgs {
  readonly system: string;
  readonly prompt: string;
  readonly schema: z.ZodType;
  readonly abortSignal: AbortSignal;
}

/** Stateless structured-output call; every invocation is a fresh inference. */
export type InstinctStructuredGenerator = (
  args: InstinctStructuredGenerationArgs,
) => Promise<InstinctStructuredGenerationResult>;

/**
 * Returns a reason when the request is unusable, otherwise `null`.
 * Checked at runtime because extensions are plain JavaScript at the
 * boundary and the classifier must never receive a malformed schema.
 */
export function validateInstinctClassificationRequest(
  request: unknown,
): string | null {
  if (typeof request !== 'object' || request === null) return 'not an object';
  const { prompt, keys, context } = request as Record<string, unknown>;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return 'prompt must be a non-empty string';
  }
  if (prompt.length > INSTINCT_CLASSIFIER_LIMITS.maxPromptLength) {
    return `prompt exceeds ${INSTINCT_CLASSIFIER_LIMITS.maxPromptLength} characters`;
  }
  if (context !== undefined && typeof context !== 'string') {
    return 'context must be a string';
  }
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
    return 'keys must be an object';
  }
  const entries = Object.entries(keys);
  if (entries.length === 0) return 'at least one key is required';
  if (entries.length > INSTINCT_CLASSIFIER_LIMITS.maxKeysPerRequest) {
    return `more than ${INSTINCT_CLASSIFIER_LIMITS.maxKeysPerRequest} keys`;
  }
  for (const [name, key] of entries) {
    if (!KEY_NAME.test(name)) return `invalid key name "${name}"`;
    const reason = validateKey(key);
    if (reason) return `key "${name}": ${reason}`;
  }
  return null;
}

function validateKey(key: unknown): string | null {
  if (typeof key !== 'object' || key === null) return 'not an object';
  const { type, description, values } = key as Record<string, unknown>;
  if (typeof description !== 'string' || description.trim().length === 0) {
    return 'description must be a non-empty string';
  }
  if (description.length > INSTINCT_CLASSIFIER_LIMITS.maxDescriptionLength) {
    return `description exceeds ${INSTINCT_CLASSIFIER_LIMITS.maxDescriptionLength} characters`;
  }
  if (type === 'boolean') return null;
  if (type !== 'enum') return `unsupported type "${String(type)}"`;
  if (!Array.isArray(values) || values.length === 0) {
    return 'enum needs at least one value';
  }
  if (values.length > INSTINCT_CLASSIFIER_LIMITS.maxEnumValues) {
    return `more than ${INSTINCT_CLASSIFIER_LIMITS.maxEnumValues} enum values`;
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > INSTINCT_CLASSIFIER_LIMITS.maxEnumValueLength
    ) {
      return 'enum values must be non-empty strings of bounded length';
    }
    if (seen.has(value)) return `duplicate enum value "${value}"`;
    seen.add(value);
  }
  return null;
}

/**
 * Assigns each request a JSON-safe, unique output key derived from the
 * extension identifier (e.g. `io.stagewise/memory` → `io_stagewise_memory`).
 */
export function createInstinctClassifierEntries(
  requests: readonly {
    extensionIdentifier: string;
    request: InstinctClassificationRequest;
  }[],
): InstinctClassifierEntry[] {
  const used = new Set<string>();
  return requests.map(({ extensionIdentifier, request }) => {
    const base = extensionIdentifier.replace(/[^A-Za-z0-9_]/g, '_') || 'ext';
    let outputKey = base;
    for (let suffix = 2; used.has(outputKey); suffix++) {
      outputKey = `${base}_${suffix}`;
    }
    used.add(outputKey);
    return { extensionIdentifier, outputKey, request };
  });
}

function keySchema(key: InstinctClassificationKey): z.ZodType {
  return key.type === 'boolean' ? z.boolean() : z.enum(key.values);
}

/** Strict schema of one extension's answer slice; every key is required. */
function createInstinctSliceSchema(
  request: InstinctClassificationRequest,
): z.ZodType {
  return z
    .object(
      Object.fromEntries(
        Object.entries(request.keys).map(([name, key]) => [
          name,
          keySchema(key).describe(key.description),
        ]),
      ),
    )
    .strict();
}

/** Schema of the whole classifier answer, namespaced by output key. */
export function createInstinctOutputSchema(
  entries: readonly InstinctClassifierEntry[],
): z.ZodType {
  return z
    .object(
      Object.fromEntries(
        entries.map((entry) => [
          entry.outputKey,
          createInstinctSliceSchema(entry.request),
        ]),
      ),
    )
    .strict();
}

function describeKey(name: string, key: InstinctClassificationKey): string {
  const type =
    key.type === 'boolean'
      ? 'boolean'
      : `one of ${key.values.map((value) => JSON.stringify(value)).join(', ')}`;
  return `- \`${name}\` (${type}): ${key.description}`;
}

/**
 * System prompt of the classifier: base prompt, history format, then one
 * section per extension in factory order. Only trusted, extension-authored
 * text goes here; conversation data belongs in the user prompt.
 */
export function renderInstinctClassifierSystemPrompt(
  entries: readonly InstinctClassifierEntry[],
): string {
  const sections = entries.map((entry) =>
    [
      `<section extension="${entry.extensionIdentifier}" output_key="${entry.outputKey}">`,
      entry.request.prompt.trim(),
      '',
      'Keys:',
      ...Object.entries(entry.request.keys).map(([name, key]) =>
        describeKey(name, key),
      ),
      '</section>',
    ].join('\n'),
  );
  return [
    classifierBasePrompt.trim(),
    'Conversation messages use this format:',
    LINES_FORMAT_PROMPT.trim(),
    ...sections,
  ].join('\n\n');
}

/**
 * Best-effort JSON recovery from raw model text: strips code fences and
 * takes the outermost object. Returns `undefined` when nothing parses.
 */
function parseLenientJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Validates each extension's slice independently, so one bad slice does not
 * cost the others their answers.
 */
export function distributeInstinctAnswers(
  entries: readonly InstinctClassifierEntry[],
  output: unknown,
  modelId: string,
): Map<string, InstinctClassificationOutcome> {
  const outcomes = new Map<string, InstinctClassificationOutcome>();
  const record =
    typeof output === 'object' && output !== null
      ? (output as Record<string, unknown>)
      : {};
  for (const entry of entries) {
    const parsed = createInstinctSliceSchema(entry.request).safeParse(
      record[entry.outputKey],
    );
    outcomes.set(
      entry.extensionIdentifier,
      parsed.success
        ? {
            status: 'ok',
            answers: parsed.data as Record<string, boolean | string>,
            modelId,
          }
        : { status: 'failed', reason: 'invalid answer slice' },
    );
  }
  return outcomes;
}

function uniformOutcome(
  entries: readonly InstinctClassifierEntry[],
  outcome: InstinctClassificationOutcome,
): Map<string, InstinctClassificationOutcome> {
  return new Map(entries.map((entry) => [entry.extensionIdentifier, outcome]));
}

interface InstinctClassifyArgs {
  readonly entries: readonly InstinctClassifierEntry[];
  /** Fully framed user prompt (external-input blocks). */
  readonly prompt: string;
  readonly generate: InstinctStructuredGenerator;
  /** Step-level cancellation (critical input, lease, close). */
  readonly signal: AbortSignal;
  /** Shared instinct deadline, distinct from caller cancellation. */
  readonly deadline?: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * Runs one fresh classifier inference for all entries and maps the result
 * to one outcome per extension. Never throws; there is no caching, so every
 * call reflects the current input.
 */
export async function classifyInstinct(
  args: InstinctClassifyArgs,
): Promise<Map<string, InstinctClassificationOutcome>> {
  const { entries, signal } = args;
  if (entries.length === 0) return new Map();
  if (signal.aborted) return uniformOutcome(entries, { status: 'aborted' });
  if (args.deadline?.aborted)
    return uniformOutcome(entries, { status: 'timeout' });

  const timeout = AbortSignal.timeout(args.timeoutMs);
  const abortSignal = AbortSignal.any([
    signal,
    timeout,
    ...(args.deadline ? [args.deadline] : []),
  ]);
  const interrupted = (): InstinctClassificationOutcome | null => {
    if (signal.aborted) return { status: 'aborted' };
    if (timeout.aborted || args.deadline?.aborted) return { status: 'timeout' };
    return null;
  };

  let onAbort: (() => void) | undefined;
  let result: InstinctStructuredGenerationResult;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortSignal.reason);
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    });
    // Promise.race observes late rejections even when the generator ignores
    // cancellation. The deadline must not depend on provider cooperation.
    const generation = Promise.resolve().then(() =>
      args.generate({
        system: renderInstinctClassifierSystemPrompt(entries),
        prompt: args.prompt,
        schema: createInstinctOutputSchema(entries),
        abortSignal,
      }),
    );
    result = await Promise.race([generation, aborted]);
  } catch (error) {
    return uniformOutcome(
      entries,
      interrupted() ?? {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    if (onAbort) abortSignal.removeEventListener('abort', onAbort);
  }

  // A late result after the deadline or an abort is discarded.
  const late = interrupted();
  if (late) return uniformOutcome(entries, late);

  switch (result.status) {
    case 'ok':
      return distributeInstinctAnswers(entries, result.output, result.modelId);
    case 'partial':
      return distributeInstinctAnswers(
        entries,
        parseLenientJson(result.text),
        result.modelId,
      );
    case 'unavailable':
      return uniformOutcome(entries, {
        status: 'unavailable',
        reason: result.reason,
      });
    case 'failed':
      return uniformOutcome(entries, {
        status: 'failed',
        reason: result.reason,
      });
  }
}
