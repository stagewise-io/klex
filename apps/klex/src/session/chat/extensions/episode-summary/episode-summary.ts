import { join } from 'node:path';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { DEFAULT_SESSION_ID } from '@/session/types';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';
import { createSummarizer, type Summarizer } from './summarizer';
import type { EpisodeSummaryLogHub } from './summary-log';
import { createSummaryStore, type SummaryStore } from './summary-store';

export const EPISODE_SUMMARY_EXTENSION_ID = 'io.stagewise/episode-summary';

export interface EpisodeSummaryExtOptions {
  episodes: EpisodeFeed;
  summaryLog: EpisodeSummaryLogHub;
}

class EpisodeSummaryExtension implements Extension {
  private store: SummaryStore | null = null;
  private summarizer: Summarizer | null = null;
  private unsubscribe: (() => void) | null = null;
  private detachLog: (() => void) | null = null;
  private release: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: EpisodeSummaryExtOptions,
    private readonly claimWorker: () => (() => void) | null,
  ) {}

  async onStart(): Promise<void> {
    if (this.closed) return;
    const release = this.claimWorker();
    if (!release) return;
    this.release = release;
    const dataDirectory = this.deps.getDataDir(true);
    const store = createSummaryStore(
      join(dataDirectory, 'summaries.sqlite'),
      dataDirectory,
    );
    this.store = store;
    try {
      await store.start();
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Episode summary store failed to start; summaries are disabled',
      );
      await this.teardown();
      return;
    }
    if (this.closed) {
      await this.teardown();
      return;
    }
    const summarizer = createSummarizer({
      episodes: this.options.episodes,
      store,
      generateText: this.deps.generateText,
      getModelIds: () => {
        const memory = this.deps.config.getModelSelection('memory');
        return memory.length > 0
          ? memory
          : this.deps.config.getModelSelection('chat');
      },
      logger: this.deps.logging.child({
        name: 'episode-summarizer',
        bindings: { module: 'episode-summarizer' },
      }),
    });
    this.summarizer = summarizer;
    this.unsubscribe = this.options.episodes.subscribe(() => summarizer.wake());
    summarizer.start();
    summarizer.wake();
    this.detachLog = this.options.summaryLog.attach({
      list: (options) => store.list(options),
    });
  }

  async onClose(): Promise<void> {
    this.closed = true;
    await this.teardown();
  }

  introspect(): Record<string, unknown> {
    return (
      this.summarizer?.introspect() ?? {
        summarizer: 'not owned by this session',
      }
    );
  }

  private async teardown(): Promise<void> {
    this.detachLog?.();
    this.detachLog = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const summarizer = this.summarizer;
    this.summarizer = null;
    await summarizer?.close();
    const store = this.store;
    this.store = null;
    await store?.close();
    this.release?.();
    this.release = null;
  }
}

class EpisodeSummaryExtensionFactory implements ExtensionFactory {
  readonly identifier = EPISODE_SUMMARY_EXTENSION_ID;
  readonly displayName = 'Episode summaries';
  private readonly claimedWorkers = new Set<string>();

  constructor(private readonly options: EpisodeSummaryExtOptions) {}

  create = (deps: ExtensionDeps): Extension => {
    const dataDirectory = deps.getDataDir(true);
    const claimWorker = (): (() => void) | null => {
      if (
        deps.sessionId !== DEFAULT_SESSION_ID ||
        this.claimedWorkers.has(dataDirectory)
      ) {
        return null;
      }
      this.claimedWorkers.add(dataDirectory);
      return () => this.claimedWorkers.delete(dataDirectory);
    };
    return new EpisodeSummaryExtension(deps, this.options, claimWorker);
  };
}

/**
 * Titles each newly finished memory episode with one cheap model call and
 * exposes the titles, newest first, through the episode summary log hub.
 */
export function createEpisodeSummaryExt(
  options: EpisodeSummaryExtOptions,
): ExtensionFactory {
  return new EpisodeSummaryExtensionFactory(options);
}
