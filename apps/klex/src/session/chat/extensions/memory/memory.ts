import { randomUUID } from 'node:crypto';

import { type ToolSet, tool } from 'ai';

import { CONTEXT_SUMMARY_KEY } from '@/session/chat/utils/history-view';

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
import {
  createMemoryRetrievalCoordinator,
  type MemoryRetrievalCoordinator,
  RecallRejectedError,
  recallInputSchema,
  renderObservation,
} from './retrieval';
import { settleBefore } from './settle-before';
import systemPromptPart from './system-prompt-part.md';

const SHUTDOWN_FLUSH_TIMEOUT_MS = 25_000;
/** Observation batches sent per step; the rest drains on later steps. */
const MAX_OBSERVATION_BATCHES_PER_STEP = 4;

type MemoryWriteReason =
  | 'step-threshold'
  | 'interval'
  | 'idle'
  | 'compaction'
  | 'shutdown';

class MemoryExt implements Extension {
  private episodicMemoryWriter: EpisodicWriter | null = null;
  private retrievalCoordinator: MemoryRetrievalCoordinator | null = null;
  private closed = false;
  private lastProcessedMessageId: string | null = null;
  /** Retrieval observation cursor; independent of the writer cursor. */
  private lastObservedMessageId: string | null = null;
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
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Failed to start memory extension — episodicMemoryWriter creation failed',
      );
      throw error;
    }
    // Kept even when startup fails: the coordinator retries in the
    // background and answers recalls itself once it gives up.
    this.retrievalCoordinator = createMemoryRetrievalCoordinator(this.deps);
    await this.retrievalCoordinator.start();
    this.deps.logger.info(
      { episodicMemoryWriterId: this.episodicMemoryWriter.sessionId },
      'Memory extension started with episodicMemoryWriter session',
    );
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.clearMemoryWriteTimer();
    this.clearEpisodeFinishTimer();
    await this.retrievalCoordinator?.close();
    this.retrievalCoordinator = null;
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

  getTools(): ToolSet {
    const coordinator = this.retrievalCoordinator;
    if (!coordinator) return {};
    return {
      recall: tool({
        description:
          'Ask memory in the background. Answers arrive later in `<memory>` blocks, including when I remember nothing. Meanwhile continue silently unless memory is strictly required.',
        inputSchema: recallInputSchema,
        execute: async (input) => {
          try {
            coordinator.remember(input);
            return 'Recalling...';
          } catch (error) {
            this.deps.logger.debug(
              { error },
              'Memory retrieval request rejected',
            );
            if (error instanceof RecallRejectedError) {
              return error.reason === 'attempt-limit'
                ? 'Already recalled this for the current task. Continue with what you know.'
                : 'Memory is busy recovering. Continue with what you know.';
            }
            return 'Recall not possible. Memory broken. Continue on best-effort basis.';
          }
        },
      }),
    };
  }

  getSystemPromptPart(): string {
    return systemPromptPart;
  }

  onStepStart(): void {
    this.clearEpisodeFinishTimer();
    this.retrievalCoordinator?.setMainTurnActive(true);
    // New incoming context reaches the retriever before main generates.
    this.observeDelta();
  }

  onStepComplete(event: StepCompleteEvent): Promise<void> {
    if (!this.closed) {
      this.retrievalCoordinator?.setMainTurnActive(event.shouldContinue);
      if (!event.fatalError) this.observeDelta();
    }
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
      lastObservedMessageId: this.lastObservedMessageId,
      pendingUserMessageCount: countPendingUserMessages(
        this.deps.getHistory(),
        this.lastProcessedMessageId,
      ),
      pendingStepCount: this.pendingStepCount,
      memoryWriteTimerActive: this.memoryWriteTimer !== null,
      episodeFinishTimerActive: this.episodeFinishTimer !== null,
      retrieval: this.retrievalCoordinator?.introspect() ?? null,
    };
  }

  /**
   * Streams the history delta since the observation cursor to the
   * retrieval child in oldest-first, budget-sized batches. Synchronous, so
   * the cursor needs no serialization. The cursor only advances past
   * delivered batches; while the child is unavailable the backlog waits,
   * and a large backlog drains over several steps.
   */
  private observeDelta(): void {
    const coordinator = this.retrievalCoordinator;
    if (this.closed || !coordinator) return;
    try {
      for (let batch = 0; batch < MAX_OBSERVATION_BATCHES_PER_STEP; batch++) {
        const history = this.deps.getHistory();
        const { text, cursor, hasMore } = renderObservation(
          history,
          this.lastObservedMessageId,
        );
        if (text && !coordinator.observe({ text })) return;
        if (cursor === this.lastObservedMessageId) return;
        this.lastObservedMessageId = cursor;
        if (!hasMore) return;
      }
      this.deps.logger.debug(
        'Memory observation backlog remains — draining on the next step',
      );
    } catch (error) {
      this.deps.logger.debug({ error }, 'Memory observation failed');
    }
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
        message.parts.some((part) => isDataPartOf(CONTEXT_SUMMARY_KEY, part)),
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
