import { randomUUID } from 'node:crypto';

import { type ToolSet, tool } from 'ai';
import z from 'zod';

import type {
  Extension,
  ExtensionFactory,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';

import {
  compactRecallScopeSchema,
  type MemoryRetrievalConfig,
  RECALL_ID_MAX_LENGTH,
  type SurfacedMemory,
} from './retrieval';
import type { EpisodicSearchIndex } from './search-index';

export interface RetrievalToolsConfig {
  index: EpisodicSearchIndex;
  retrieval: MemoryRetrievalConfig;
  /** Receives every accepted `surfaceMemory` call. */
  onSurface: (memory: SurfacedMemory) => void;
}

interface TurnBudget {
  searchCalls: number;
  readCalls: number;
  outputCharacters: number;
  unresolvedHandles: number;
  surfaced: number;
  /** Index synced with the episodic markdown store this turn. */
  reconciled: boolean;
}

function emptyBudget(): TurnBudget {
  return {
    searchCalls: 0,
    readCalls: 0,
    outputCharacters: 0,
    unresolvedHandles: 0,
    surfaced: 0,
    reconciled: false,
  };
}

/**
 * Tools of the retrieval child. Budgets and search-handle ownership are
 * scoped to one child turn: recalls and observations both arrive through
 * the child inbox, so a turn is the only unit covering either.
 */
class RetrievalToolsExt implements Extension {
  private turnId: string | null = null;
  private budget: TurnBudget = emptyBudget();

  constructor(private readonly options: RetrievalToolsConfig) {}

  onStepStart(): void {
    if (this.turnId) return;
    this.turnId = randomUUID();
    this.budget = emptyBudget();
  }

  onStepComplete(event: StepCompleteEvent): void {
    if (event.shouldContinue && !event.fatalError) return;
    if (this.turnId) this.options.index.clearOwner(this.turnId);
    this.turnId = null;
  }

  /** Search-handle owner of the current turn. */
  private currentOwner(): string {
    return this.turnId ?? 'default';
  }

  /** Picks up episodes written since the last turn, once per turn. */
  private async ensureFresh(): Promise<void> {
    if (this.budget.reconciled) return;
    await this.options.index.reconcile();
    this.budget.reconciled = true;
  }

  getTools(): ToolSet {
    const { index, retrieval } = this.options;
    return {
      surfaceMemory: tool({
        description:
          'Report one relevant memory to my main self. Only reported memories reach me; plain text is discarded. recallId: the id of the <recall> this answers; omit for observations. Optional followUps: short questions this memory could further answer.',
        inputSchema: z.object({
          scope: compactRecallScopeSchema,
          memory: z
            .string()
            .trim()
            .min(1)
            .max(retrieval.maxSurfacedMemoryCharacters),
          followUps: z
            .array(
              z.string().trim().min(1).max(retrieval.maxFollowUpCharacters),
            )
            .max(retrieval.maxFollowUpsPerMemory)
            .default([]),
          recallId: z
            .string()
            .trim()
            .min(1)
            .max(RECALL_ID_MAX_LENGTH)
            .optional(),
        }),
        execute: async ({ scope, memory, followUps, recallId }) => {
          this.budget.surfaced += 1;
          if (this.budget.surfaced > retrieval.maxSurfacedMemoriesPerTurn)
            return { error: 'surface budget exhausted' };
          this.options.onSurface({
            scope,
            memory,
            followUps,
            ...(recallId ? { recallId } : {}),
          });
          return { ok: true };
        },
      }),
      inspectMemory: tool({
        description:
          'Inspect authorized episodic-memory index coverage before searching.',
        inputSchema: z.object({}),
        execute: async () => {
          await this.ensureFresh();
          return index.getState();
        },
      }),
      searchMemory: tool({
        description:
          'Search episodic memory using concise English terms from the recall or observation. Typo-tolerant: auto mode also matches spelling variants of unknown terms; fuzzy mode expands every term. Not synonym-aware: search again with other wording if needed.',
        inputSchema: z.object({
          query: z.string().trim().min(1).max(2_000),
          mode: z.enum(['auto', 'exact', 'fuzzy']).default('auto'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(retrieval.maxSearchResults)
            .optional(),
        }),
        execute: async ({ query, mode, limit }) => {
          const owner = this.currentOwner();
          const { budget } = this;
          budget.searchCalls += 1;
          if (budget.searchCalls > retrieval.maxSearchCallsPerTurn)
            return { error: 'search budget exhausted', hits: [] };
          await this.ensureFresh();
          const resultLimit = limit ?? retrieval.maxSearchResults;
          let hits =
            mode === 'fuzzy'
              ? []
              : await index.search(query, resultLimit, owner);
          let expandedTerms: string[] = [];
          if (mode !== 'exact') {
            // Auto mode corrects unknown terms even when other terms already
            // matched; with no exact hits, every term is expanded.
            const expansion = await index.expandQuery(query, {
              onlyUnknown: mode === 'auto' && hits.length > 0,
            });
            expandedTerms = expansion.expandedTerms;
            if (expandedTerms.length > 0) {
              index.clearHandles(hits.map((hit) => hit.handle));
              hits = await index.search(expansion.query, resultLimit, owner);
            }
          }
          const responseHits = hits.map((hit) => ({
            ...hit,
            snippet: hit.snippet.slice(
              0,
              retrieval.searchSnippetCharacterLimit,
            ),
          }));
          budget.outputCharacters += JSON.stringify(responseHits).length;
          if (
            budget.outputCharacters > retrieval.maxToolOutputCharactersPerTurn
          )
            return { error: 'tool output budget exhausted', hits: [] };
          return {
            mode,
            ...index.getState(),
            ...(expandedTerms.length > 0 ? { expandedTerms } : {}),
            hits: responseHits,
          };
        },
      }),
      readMemoryContext: tool({
        description:
          'Read a small chronological context window around selected search handles.',
        inputSchema: z.object({
          handles: z
            .array(z.string())
            .min(1)
            .max(retrieval.maxContextReadHandles),
          before: z.number().int().min(0).max(2).default(1),
          after: z.number().int().min(0).max(2).default(1),
        }),
        execute: async ({ handles, before, after }) => {
          const owner = this.currentOwner();
          const { budget } = this;
          budget.readCalls += 1;
          budget.unresolvedHandles += handles.length;
          if (
            budget.readCalls > retrieval.maxContextReadCallsPerTurn ||
            budget.unresolvedHandles > retrieval.maxUnresolvedHandlesPerTurn
          )
            return {
              error: 'context-read budget exhausted',
              entries: [],
              text: '',
            };
          const entries = await index.readHandles(
            handles,
            before,
            after,
            owner,
          );
          const text = entries
            .map((entry) => `${entry.occurredAt}: ${entry.text}`)
            .join('\n')
            .slice(0, retrieval.maxContextReadCharacters);
          budget.outputCharacters += JSON.stringify({ text }).length;
          if (
            budget.outputCharacters > retrieval.maxToolOutputCharactersPerTurn
          )
            return {
              error: 'tool output budget exhausted',
              entries: [],
              text: '',
            };
          return { text };
        },
      }),
    };
  }
}

export function createRetrievalToolsExt(
  options: RetrievalToolsConfig,
): ExtensionFactory {
  return {
    identifier: 'io.stagewise/memory-retrieval-tools',
    displayName: 'Memory Retrieval Tools',
    create: () => new RetrievalToolsExt(options),
  };
}
