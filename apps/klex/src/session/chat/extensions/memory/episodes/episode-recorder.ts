import type { ModuleLogger } from '@stagewise/logger';

import type { ExtendedUIMessage } from '../../../message-types';
import {
  resolveCheckpointCursor,
  type StagedCheckpoint,
} from '../checkpoint-cursor';
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
  private staged: StagedCheckpoint | null = null;
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
   * Announces a checkpoint that may trim the cursor. The cursor moves to
   * the header only once the trim is visible in the window, so an aborted
   * or deferred apply leaves it untouched.
   */
  stageCheckpoint(checkpoint: StagedCheckpoint): void {
    this.staged = checkpoint;
  }

  /** Records the window delta; resolves `false` when the append failed. */
  async flush(): Promise<boolean> {
    const history = this.deps.getHistory();
    this.cursor = resolveCheckpointCursor(this.cursor, history, this.staged);
    if (
      this.cursor !== null &&
      !history.some((message) => message.id === this.cursor)
    ) {
      // Staged checkpoints resolve trimmed cursors, so this is a bug.
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
