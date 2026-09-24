import z from 'zod';

const RECALL_SCOPE_MAX_LENGTH = 256;
const RECALL_QUESTION_MAX_LENGTH = 4_000;

export interface MemoryRetrievalConfig {
  /** Recalls buffered while the retrieval child is unavailable. */
  maxBufferedRecalls: number;
  /**
   * How long a recall id stays answerable. Surfaces citing an open recall id
   * wake the main session and bypass duplicate suppression.
   */
  recallAnswerWindowMs: number;
  /** Retrieval-child tool budgets below apply per child turn. */
  maxSearchCallsPerTurn: number;
  maxSearchResults: number;
  searchSnippetCharacterLimit: number;
  maxContextReadHandles: number;
  maxContextReadCharacters: number;
  maxContextReadCallsPerTurn: number;
  maxToolOutputCharactersPerTurn: number;
  maxUnresolvedHandlesPerTurn: number;
  maxRecallAttemptsPerMainTask: number;
  /** Stream main-session observations into the retrieval child. */
  proactiveEnabled: boolean;
  maxSurfacedMemoriesPerTurn: number;
  maxSurfacedMemoryCharacters: number;
  maxFollowUpsPerMemory: number;
  maxFollowUpCharacters: number;
}

export const DEFAULT_MEMORY_RETRIEVAL_CONFIG: MemoryRetrievalConfig = {
  maxBufferedRecalls: 32,
  recallAnswerWindowMs: 120_000,
  maxSearchCallsPerTurn: 4,
  maxSearchResults: 8,
  searchSnippetCharacterLimit: 300,
  maxContextReadHandles: 4,
  maxContextReadCharacters: 4_000,
  maxContextReadCallsPerTurn: 4,
  maxToolOutputCharactersPerTurn: 12_000,
  maxUnresolvedHandlesPerTurn: 8,
  maxRecallAttemptsPerMainTask: 2,
  proactiveEnabled: true,
  maxSurfacedMemoriesPerTurn: 3,
  maxSurfacedMemoryCharacters: 800,
  maxFollowUpsPerMemory: 3,
  maxFollowUpCharacters: 150,
};

/** One memory reported by the retrieval child via `surfaceMemory`. */
export interface SurfacedMemory {
  scope: string;
  memory: string;
  followUps: string[];
  /** Id of the `<recall>` this memory answers; absent for observations. */
  recallId?: string;
}

export const RECALL_ID_MAX_LENGTH = 32;

export const compactRecallScopeSchema = z
  .string()
  .trim()
  .max(RECALL_SCOPE_MAX_LENGTH)
  .refine(
    (value) =>
      /^[A-Za-z0-9._-]+(?:\s+(?:conversation|user):[A-Za-z0-9._:@/-]+){0,2}$/iu.test(
        value,
      ),
    'Scope must contain an app name and optional conversation:/user: locators',
  );

export const recallInputSchema = z
  .object({
    question: z.string().trim().min(1).max(RECALL_QUESTION_MAX_LENGTH),
    scope: compactRecallScopeSchema.optional(),
  })
  .strict();

export type RecallInput = z.infer<typeof recallInputSchema>;

/** Case-insensitive identity of a recall, used for attempt limits. */
export function recallFingerprint(input: RecallInput): string {
  return `${input.question.trim().toLocaleLowerCase('en-US')}\u0000${input.scope?.trim().toLocaleLowerCase('en-US') ?? ''}`;
}

/**
 * Renders a recall as the retrieval child's inbox message text. `id` is
 * coordinator-generated and cited back via `surfaceMemory.recallId`.
 */
export function renderRecall(input: RecallInput, id: string): string {
  const scope = input.scope?.trim() || 'unspecified scope';
  return `<recall id="${id}">\n[${scope}] ${input.question.trim()}\n</recall>`;
}
