import type { ModuleLogger } from '@stagewise/logger';

import type { ModelSelectionEntry } from '@/config';
import type {
  CompletedEpisode,
  EpisodeFeed,
} from '@/session/chat/extensions/memory';
import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';

import type { GenerateTextArgs, GenerateTextResult } from '../extension-api';
import summaryPrompt from './summary-prompt.md';
import type { SummaryRow, SummaryStore } from './summary-store';

/** Character budget for one episode's text in the summary prompt. */
export const MAX_INPUT_CHARACTERS = 12_000;
const HEAD_CHARACTERS = 4_000;
const OMITTED_MARKER = '\n\n[… middle omitted …]\n\n';
/** Episodes with fewer records are skipped without a model call. */
export const MIN_RECORDS = 2;
/**
 * Reasoning models spend most of the budget thinking before the title, so
 * 256 truncated them in E2E runs. Title length is enforced by `parseTitle`.
 * No temperature: reasoning models the provider does not recognize reject it.
 */
export const MAX_OUTPUT_TOKENS = 1024;
const PASS_BATCH = 20;
const MAX_TITLE_WORDS = 12;
const MAX_TITLE_CHARACTERS = 100;
const SKIP_TOKEN = 'SKIP';

/** Keeps the start and the (more outcome-relevant) end of long episodes. */
export function buildEpisodeInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARACTERS) return text;
  const tailCharacters =
    MAX_INPUT_CHARACTERS - HEAD_CHARACTERS - OMITTED_MARKER.length;
  return `${text.slice(0, HEAD_CHARACTERS)}${OMITTED_MARKER}${text.slice(-tailCharacters)}`;
}

/** Normalizes model output to one short title, or null for "skip". */
export function parseTitle(raw: string): string | null {
  const line = raw
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return null;
  let title = line
    .replace(/^(?:[-*•]|\d+[.)])\s+/u, '')
    .replace(/^(?:title:\s*)/iu, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.。]+$/u, '')
    .trim();
  if (!title || title.toUpperCase() === SKIP_TOKEN) return null;
  const words = title.split(' ');
  if (words.length > MAX_TITLE_WORDS)
    title = words.slice(0, MAX_TITLE_WORDS).join(' ');
  if (title.length > MAX_TITLE_CHARACTERS)
    title = title.slice(0, MAX_TITLE_CHARACTERS).trimEnd();
  return title;
}

export const SUMMARY_SYSTEM_PROMPT = `${summaryPrompt.trim()}\n\n${LINES_FORMAT_PROMPT}`;

export interface SummarizerDependencies {
  episodes: EpisodeFeed;
  store: SummaryStore;
  generateText: (args: GenerateTextArgs) => Promise<GenerateTextResult>;
  getModelIds: () => readonly ModelSelectionEntry[];
  logger: ModuleLogger;
  now?: () => Date;
}

/** Drains newly finished episodes into titled summary rows, one pass at a time. */
export interface Summarizer {
  start(): void;
  /** Hints that episodes may have finished; never blocks. */
  wake(): void;
  close(): Promise<void>;
  introspect(): Record<string, unknown>;
}

class SummarizerModule implements Summarizer {
  private readonly abort = new AbortController();
  private started = false;
  private closed = false;
  private dirty = false;
  private running: Promise<void> | null = null;
  private lastError: string | null = null;
  private processed = 0;

  constructor(private readonly deps: SummarizerDependencies) {}

  start(): void {
    this.started = true;
  }

  wake(): void {
    if (!this.started || this.closed) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
      // A wake between the loop's last `dirty` check and this callback
      // would otherwise be dropped.
      if (this.dirty) this.wake();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await this.running;
  }

  introspect(): Record<string, unknown> {
    return {
      running: this.running !== null,
      dirty: this.dirty,
      processed: this.processed,
      lastError: this.lastError,
    };
  }

  private async loop(): Promise<void> {
    do {
      this.dirty = false;
      try {
        await this.pass();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn({ error }, 'Episode summary pass failed');
        return;
      }
    } while (this.dirty && !this.closed);
  }

  private async pass(): Promise<void> {
    const { episodes, store } = this.deps;
    if (this.closed || !episodes.isAvailable()) return;
    const cursor = await store.getCursor();
    if (!cursor.initialized) {
      // Only episodes finishing after the first start get summaries.
      const [latest] = await episodes.listLatestCompleted(1);
      await store.initializeCursor(latest?.id ?? null);
      return;
    }
    let after = cursor.episodeId;
    while (!this.closed) {
      const refs = await episodes.listCompleted(after, PASS_BATCH);
      if (refs.length === 0) return;
      for (const ref of refs) {
        if (this.closed) return;
        const episode = await episodes.read(ref.id);
        if (!episode) {
          if (!episodes.isAvailable()) return;
          await this.commit(ref.id, null, 'skipped', null);
        } else if (episode.recordCount < MIN_RECORDS) {
          await this.commit(ref.id, episode, 'skipped', null);
        } else if (!(await this.summarize(episode))) {
          return;
        }
        after = ref.id;
      }
    }
  }

  /** Returns false when the pass must stop with the cursor unchanged. */
  private async summarize(episode: CompletedEpisode): Promise<boolean> {
    const result = await this.deps.generateText({
      modelIds: this.deps.getModelIds(),
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: buildEpisodeInput(episode.text),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: this.abort.signal,
    });
    if (!result.success) {
      if (result.failureReason !== 'aborted') {
        this.lastError = `${result.failureReason}${result.failureDetails ? `: ${result.failureDetails}` : ''}`;
        this.deps.logger.warn(
          {
            episodeId: episode.id,
            failureReason: result.failureReason,
            failureDetails: result.failureDetails,
          },
          'Episode summary generation failed; retrying on the next episode event',
        );
      }
      return false;
    }
    if (this.closed) return false;
    // Truncated or empty output is not a model decision to skip; storing it
    // would permanently lose the title, so retry like a failed call.
    if (result.finishReason === 'length' || result.text.trim() === '') {
      this.lastError = `incomplete output (${result.finishReason})`;
      this.deps.logger.warn(
        { episodeId: episode.id, finishReason: result.finishReason },
        'Episode summary output was incomplete; retrying on the next episode event',
      );
      return false;
    }
    const title = parseTitle(result.text);
    await this.commit(
      episode.id,
      episode,
      title ? 'titled' : 'skipped',
      title,
      result.modelId,
    );
    return true;
  }

  private async commit(
    episodeId: string,
    episode: CompletedEpisode | null,
    status: SummaryRow['status'],
    title: string | null,
    modelId: string | null = null,
  ): Promise<void> {
    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    await this.deps.store.commit({
      episodeId,
      status,
      title,
      startedAt: episode?.startedAt ?? createdAt,
      endedAt: episode?.endedAt ?? createdAt,
      createdAt,
      modelId,
    });
    this.processed += 1;
    this.lastError = null;
  }
}

export function createSummarizer(deps: SummarizerDependencies): Summarizer {
  return new SummarizerModule(deps);
}
