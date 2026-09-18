import { randomUUID } from 'node:crypto';

import type { ExtendedUIMessage } from '../../message-types';
import {
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  isDataPartOf,
  type StepCompleteEvent,
} from '../extension-api';
import { createEpisodicWriter, type EpisodicWriter } from './episodic-writer';
import {
  compressHistoryForWriter,
  countPendingUserMessages,
} from './history-compression';

const SHUTDOWN_FLUSH_TIMEOUT_MS = 25_000;
const COMPACTION_SUMMARY_KEY = 'context-summary';

type MemoryWriteReason =
  | 'step-threshold'
  | 'interval'
  | 'idle'
  | 'compaction'
  | 'shutdown';

class MemoryExt implements Extension {
  private episodicMemoryWriter: EpisodicWriter | null = null;
  private closed = false;
  private lastProcessedMessageId: string | null = null;
  private pendingStepCount = 0;
  private memoryWriteTimer: NodeJS.Timeout | null = null;
  private episodeFinishTimer: NodeJS.Timeout | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly timezone: string,
  ) {}

  async onStart(): Promise<void> {
    if (this.episodicMemoryWriter) return;
    try {
      this.episodicMemoryWriter = await createEpisodicWriter(
        this.deps,
        this.timezone,
      );
      this.deps.logger.info(
        { episodicMemoryWriterId: this.episodicMemoryWriter.sessionId },
        'Memory extension started with episodicMemoryWriter session',
      );
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Failed to start memory extension — episodicMemoryWriter creation failed',
      );
      throw error;
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.clearMemoryWriteTimer();
    this.clearEpisodeFinishTimer();
    const writer = this.episodicMemoryWriter;
    if (!writer) return;

    const deadline = Date.now() + SHUTDOWN_FLUSH_TIMEOUT_MS;
    const shutdown = this.serialize(async () => {
      let finalSubmissionSucceeded = true;
      if (this.hasUnprocessedHistory(this.deps.getHistory())) {
        finalSubmissionSucceeded = await this.flushMemory('shutdown');
      }
      const writerBecameIdle = await writer.waitForIdle(
        Math.max(0, deadline - Date.now()),
      );
      if (!writerBecameIdle) {
        this.deps.logger.warn(
          { timeoutMs: SHUTDOWN_FLUSH_TIMEOUT_MS },
          'episodicMemoryWriter did not become idle before shutdown deadline',
        );
      } else if (finalSubmissionSucceeded) {
        this.deps.logger.info(
          'episodicMemoryWriter completed pending work before shutdown',
        );
      }
    });

    if (!(await settleBefore(shutdown, deadline))) {
      this.deps.logger.warn(
        { timeoutMs: SHUTDOWN_FLUSH_TIMEOUT_MS },
        'Memory shutdown deadline reached — closing episodicMemoryWriter with buffered work',
      );
    }

    const closing = writer.close().catch((error: unknown) => {
      this.deps.logger.error(
        { error },
        'Failed to close episodicMemoryWriter session',
      );
    });
    await settleBefore(closing, deadline);
    this.episodicMemoryWriter = null;
    this.deps.logger.info('Memory extension closed');
  }

  onStepStart(): void {
    this.clearEpisodeFinishTimer();
  }

  onStepComplete(event: StepCompleteEvent): Promise<void> {
    return this.serialize(async () => {
      if (this.closed || event.fatalError) return;
      const history = this.deps.getHistory();
      if (this.hasUnprocessedHistory(history)) {
        this.pendingStepCount++;
        const reason = this.hasUnprocessedCompactionSummary(history)
          ? 'compaction'
          : this.pendingStepCount >=
              this.deps.config.get().memoryWriteStepInterval
            ? 'step-threshold'
            : null;
        if (reason) {
          if (!(await this.flushMemory(reason))) this.ensureMemoryWriteTimer();
        } else {
          this.ensureMemoryWriteTimer();
        }
      }
      if (!event.shouldContinue) this.setEpisodeFinishTimer();
    });
  }

  introspect(): Record<string, unknown> {
    return {
      episodicMemoryWriterId: this.episodicMemoryWriter?.sessionId ?? null,
      timezone: this.timezone,
      lastProcessedMessageId: this.lastProcessedMessageId,
      pendingUserMessageCount: countPendingUserMessages(
        this.deps.getHistory(),
        this.lastProcessedMessageId,
      ),
      pendingStepCount: this.pendingStepCount,
      memoryWriteTimerActive: this.memoryWriteTimer !== null,
      episodeFinishTimerActive: this.episodeFinishTimer !== null,
    };
  }

  private async flushMemory(reason: MemoryWriteReason): Promise<boolean> {
    if (this.closed && reason !== 'shutdown') return false;
    const history = this.deps.getHistory();
    if (!this.hasUnprocessedHistory(history)) return true;

    try {
      const writer = this.episodicMemoryWriter;
      if (!writer) throw new Error('episodicMemoryWriter is not initialized');
      const { text, parts, lastProcessedMessageId } = compressHistoryForWriter(
        history,
        this.lastProcessedMessageId,
      );
      if (parts.length > 0) await writer.submit(createWriterMessage(parts));
      this.lastProcessedMessageId = lastProcessedMessageId;
      this.pendingStepCount = 0;
      this.clearMemoryWriteTimer();
      if (!this.closed && this.hasUnprocessedHistory(history)) {
        this.ensureMemoryWriteTimer();
      }
      this.deps.logger.info(
        { reason, summaryLength: text.length },
        text.length > 0
          ? 'Memory writing triggered — summary sent to episodicMemoryWriter'
          : 'Memory history cursor advanced — delta contained no writer content',
      );
      return true;
    } catch (error) {
      this.deps.logger.error({ error }, 'Memory writing trigger failed');
      return false;
    }
  }

  private hasUnprocessedHistory(
    history: readonly ExtendedUIMessage[],
  ): boolean {
    const latestMessage = history.at(-1);
    return (
      latestMessage !== undefined &&
      latestMessage.id !== this.lastProcessedMessageId
    );
  }

  private hasUnprocessedCompactionSummary(
    history: readonly ExtendedUIMessage[],
  ): boolean {
    const cursorIndex =
      this.lastProcessedMessageId === null
        ? -1
        : history.findIndex(
            (message) => message.id === this.lastProcessedMessageId,
          );
    return history
      .slice(cursorIndex < 0 ? 0 : cursorIndex + 1)
      .some((message) =>
        message.parts.some((part) =>
          isDataPartOf(COMPACTION_SUMMARY_KEY, part),
        ),
      );
  }

  private ensureMemoryWriteTimer(): void {
    if (this.memoryWriteTimer) return;
    const timeoutMs = this.deps.config.get().memoryWriteIntervalMs;
    this.memoryWriteTimer = setTimeout(() => {
      this.memoryWriteTimer = null;
      void this.serialize(async () => {
        if (this.closed) return;
        if (!(await this.flushMemory('interval'))) {
          this.ensureMemoryWriteTimer();
        }
      });
    }, timeoutMs);
  }

  private clearMemoryWriteTimer(): void {
    if (!this.memoryWriteTimer) return;
    clearTimeout(this.memoryWriteTimer);
    this.memoryWriteTimer = null;
  }

  private setEpisodeFinishTimer(): void {
    this.clearEpisodeFinishTimer();
    const timeoutMs = this.deps.config.get().episodeFinishIdleTriggerTimeMs;
    this.episodeFinishTimer = setTimeout(() => {
      this.episodeFinishTimer = null;
      void this.serialize(async () => {
        if (this.closed) return;
        await this.flushMemory('idle');
        const writer = this.episodicMemoryWriter;
        if (!writer) return;
        if (!(await writer.waitForIdle(SHUTDOWN_FLUSH_TIMEOUT_MS))) {
          this.deps.logger.warn(
            { timeoutMs: SHUTDOWN_FLUSH_TIMEOUT_MS },
            'episodicMemoryWriter did not become idle before episode finish',
          );
          return;
        }
        await writer.finishCurrentEpisode();
      });
    }, timeoutMs);
  }

  private clearEpisodeFinishTimer(): void {
    if (!this.episodeFinishTimer) return;
    clearTimeout(this.episodeFinishTimer);
    this.episodeFinishTimer = null;
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const result = this.operation.then(action, action);
    this.operation = result.catch(() => undefined);
    return result;
  }
}

async function settleBefore(
  promise: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  return new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(resolve, remaining, false);
    void promise.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function createWriterMessage(
  parts: ExtendedUIMessage['parts'],
): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts,
  };
}

export interface MemoryExtConfig {
  /** IANA timezone resolved once during process startup. */
  timezone: string;
}

/** Maintains episodic memory using the process-start timezone. */
export function createMemoryExt(config: MemoryExtConfig): ExtensionFactory {
  const timezone = config.timezone;
  return {
    identifier: 'io.stagewise/memory',
    displayName: 'Memory',
    create: (deps) => new MemoryExt(deps, timezone),
  };
}
