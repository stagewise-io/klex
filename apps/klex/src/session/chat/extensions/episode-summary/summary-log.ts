export interface EpisodeSummary {
  episodeId: string;
  title: string;
  startedAt: string;
  endedAt: string;
  createdAt: string;
}

export interface EpisodeSummaryPage {
  items: EpisodeSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface EpisodeSummaryListOptions {
  limit: number;
  /** `episodeId` of the last item of the previous page. */
  cursor?: string;
}

/** Read-only view of titled episodes, newest first, e.g. for the admin API. */
export interface EpisodeSummaryLog {
  isAvailable(): boolean;
  list(options: EpisodeSummaryListOptions): Promise<EpisodeSummaryPage>;
}

export interface EpisodeSummaryLogSource {
  list(options: EpisodeSummaryListOptions): Promise<EpisodeSummaryPage>;
}

export interface EpisodeSummaryLogHub extends EpisodeSummaryLog {
  /** Attaches the live summary store. Returns a detach function. */
  attach(source: EpisodeSummaryLogSource): () => void;
}

class EpisodeSummaryLogModule implements EpisodeSummaryLogHub {
  private source: EpisodeSummaryLogSource | null = null;

  attach(source: EpisodeSummaryLogSource): () => void {
    if (this.source) throw new Error('Episode summary log is already attached');
    this.source = source;
    return () => {
      if (this.source === source) this.source = null;
    };
  }

  isAvailable(): boolean {
    return this.source !== null;
  }

  async list(options: EpisodeSummaryListOptions): Promise<EpisodeSummaryPage> {
    if (!this.source) return { items: [], nextCursor: null, hasMore: false };
    return this.source.list(options);
  }
}

export function createEpisodeSummaryLog(): EpisodeSummaryLogHub {
  return new EpisodeSummaryLogModule();
}
