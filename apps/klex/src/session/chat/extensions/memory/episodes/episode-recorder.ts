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

interface RecorderCursor {
  id: string;
  index: number;
}

export interface EpisodeRecorderState {
  cursor: RecorderCursor | null;
  lastError: string | null;
  episode: ReturnType<EpisodeStore['introspect']>;
}

/** Deterministically records the canonical compressed history into episodes. */
export class EpisodeRecorder {
  readonly store: EpisodeStore;
  private cursor: RecorderCursor | null = null;
  private lastError: unknown = null;

  constructor(private readonly deps: RecorderDependencies) {
    this.store = deps.store;
  }

  async flush(): Promise<void> {
    const history = this.deps.getHistory();
    const scope =
      this.cursor === null
        ? null
        : history.some((message) => message.id === this.cursor?.id)
          ? this.cursor.id
          : this.scopeAfterMissingCursor(history);
    const collected = collectEpisodicHistory(history, scope);
    const records = toEpisodeRecordInputs(collected.messages);

    try {
      if (records.length > 0) await this.store.append(records);
      this.cursor =
        collected.cursor === null
          ? null
          : { id: collected.cursor, index: history.length - 1 };
      this.lastError = null;
    } catch (error) {
      this.lastError = error;
      this.deps.logger.error({ error }, 'Episode history recording failed');
    }
  }

  introspect(): EpisodeRecorderState {
    return {
      cursor: this.cursor,
      lastError: this.lastError ? String(this.lastError) : null,
      episode: this.store.introspect(),
    };
  }

  private scopeAfterMissingCursor(
    history: readonly ExtendedUIMessage[],
  ): string | null {
    const index = Math.min(this.cursor?.index ?? 0, history.length) - 1;
    this.deps.logger.warn(
      { cursorId: this.cursor?.id, cursorIndex: this.cursor?.index },
      'Episode history cursor disappeared; rescoping before removed message',
    );
    return history[index]?.id ?? null;
  }
}

export function createEpisodeRecorder(
  deps: RecorderDependencies,
): EpisodeRecorder {
  return new EpisodeRecorder(deps);
}
