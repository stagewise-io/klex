import type { ModuleLogger } from '@stagewise/logger';

import type { ExtendedUIMessage } from '../../../message-types';
import { collectEpisodicHistory } from '../history-compression';
import type { EpisodeStore } from './episode-files';
import { toEpisodeRecordInputs } from './episode-format';

interface RecorderDependencies {
  getHistory: () => readonly ExtendedUIMessage[];
  store: EpisodeStore;
  logger: ModuleLogger;
}

export interface EpisodeRecorderState {
  /** ID of the last recorded window message; records resume after it. */
  cursor: string | null;
  lastError: string | null;
  episode: ReturnType<EpisodeStore['introspect']>;
}

/** Deterministically records the canonical compressed history into episodes. */
export class EpisodeRecorder {
  readonly store: EpisodeStore;
  private cursor: string | null = null;
  private lastError: unknown = null;

  constructor(private readonly deps: RecorderDependencies) {
    this.store = deps.store;
  }

  /**
   * Marks every message of `window` as already recorded. Used at start so a
   * restored window is not recorded a second time.
   */
  seed(window: readonly ExtendedUIMessage[]): void {
    this.cursor = window.at(-1)?.id ?? null;
  }

  /**
   * Re-points a cursor that is about to leave the window to the checkpoint
   * header. After-cursor scoping then covers exactly the raw tail.
   */
  repoint(
    droppedMessageIds: readonly string[],
    checkpointMessageId: string,
  ): void {
    if (this.cursor !== null && droppedMessageIds.includes(this.cursor)) {
      this.cursor = checkpointMessageId;
    }
  }

  /** Records the window delta; resolves `false` when the append failed. */
  async flush(): Promise<boolean> {
    const history = this.deps.getHistory();
    if (
      this.cursor !== null &&
      !history.some((message) => message.id === this.cursor)
    ) {
      // Checkpoints re-point the cursor before trimming, so this is a bug.
      // Skipping to the window end loses records but never duplicates them.
      this.deps.logger.error(
        { cursorId: this.cursor },
        'Episode history cursor left the window; skipping to its end',
      );
      this.seed(history);
      return true;
    }
    const collected = collectEpisodicHistory(history, this.cursor);
    const records = toEpisodeRecordInputs(collected.messages);

    try {
      if (records.length > 0) await this.store.append(records);
      this.cursor = collected.cursor;
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error;
      this.deps.logger.error({ error }, 'Episode history recording failed');
      return false;
    }
  }

  introspect(): EpisodeRecorderState {
    return {
      cursor: this.cursor,
      lastError: this.lastError ? String(this.lastError) : null,
      episode: this.store.introspect(),
    };
  }
}

export function createEpisodeRecorder(
  deps: RecorderDependencies,
): EpisodeRecorder {
  return new EpisodeRecorder(deps);
}
