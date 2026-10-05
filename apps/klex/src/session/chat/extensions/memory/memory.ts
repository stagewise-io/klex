import { join } from 'node:path';

import { type ToolSet, tool } from 'ai';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
} from '../extension-api';
import {
  createEpisodeRecorder,
  type EpisodeRecorder,
  EpisodeStore,
} from './episodes';
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
const EPISODE_FLUSH_INTERVAL_MS = 30_000;

class MemoryExt implements Extension {
  private unregisterAdmission: (() => void) | undefined;
  private recorder: EpisodeRecorder | null = null;
  private retrievalCoordinator: MemoryRetrievalCoordinator | null = null;
  private closed = false;
  /** Retrieval observation cursor; independent of the recorder cursor. */
  private lastObservedMessageId: string | null = null;
  // If step.run throws after onStepStart, this stays true until the next step;
  // the interval pauses, while shutdown still flushes.
  private stepActive = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ExtensionDeps) {}

  async onStart(): Promise<void> {
    if (this.recorder) return;
    const store = new EpisodeStore({
      episodicDir: join(this.deps.getDataDir(true), 'episodic'),
      getLimits: () => this.deps.config.get().extensions.memory.episodes,
      logger: this.deps.logger,
    });
    this.recorder = createEpisodeRecorder({
      getHistory: () => this.deps.getHistory(),
      store,
      logger: this.deps.logger,
    });
    this.unregisterAdmission = this.deps.admission?.register(() => {
      const state = this.recorder?.introspect();
      if (state?.lastError) return ['Memory persistence is uncertain'];
      const history = this.deps.getHistory();
      const latest = history.at(-1);
      // A successful shutdown flush is not a pre-teardown persistence proof.
      // Keep maintenance closed until the live recorder catches up.
      if (
        latest &&
        (state?.cursor?.id !== latest.id ||
          state.cursor.index !== history.length - 1)
      ) {
        return ['Memory history awaits persistence'];
      }
      return [];
    });
    this.flushTimer = setInterval(() => {
      const flush = () =>
        this.serialize(async () => {
          if (this.closed || this.stepActive) return;
          await this.recorder?.flush();
        });
      const run = () => {
        const operation = this.deps.admission
          ? this.deps.admission.run(flush)
          : flush();
        void operation.catch((error) =>
          this.deps.logger.error({ error }, 'Memory flush failed'),
        );
      };
      if (this.deps.admission) this.deps.admission.background(this, run);
      else run();
    }, EPISODE_FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    this.retrievalCoordinator = createMemoryRetrievalCoordinator(this.deps);
    await this.retrievalCoordinator.start();
    this.deps.logger.info('Memory extension started');
  }

  async onClose(): Promise<void> {
    this.unregisterAdmission?.();
    this.unregisterAdmission = undefined;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.retrievalCoordinator?.close();
    this.retrievalCoordinator = null;
    const deadline = Date.now() + SHUTDOWN_FLUSH_TIMEOUT_MS;
    const flush = this.serialize(async () => {
      await this.recorder?.flush();
    });
    if (!(await settleBefore(flush, deadline))) {
      this.deps.logger.warn(
        { timeoutMs: SHUTDOWN_FLUSH_TIMEOUT_MS },
        'Memory shutdown flush did not finish before deadline',
      );
    }
    this.recorder = null;
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
    this.stepActive = true;
    void this.recorder?.store.observeActivity();
    this.retrievalCoordinator?.setMainTurnActive(true);
    // New incoming context reaches the retriever before main generates.
    this.observeDelta();
  }

  onStepComplete(event: StepCompleteEvent): Promise<void> {
    if (!this.closed) {
      this.retrievalCoordinator?.setMainTurnActive(event.shouldContinue);
      if (!event.fatalError) this.observeDelta();
    }
    this.stepActive = false;
    // The step kept the session busy; a long step must not count as idle.
    const extend = () => this.recorder?.store.extendActivity();
    const activity = this.deps.admission
      ? this.deps.admission.run(extend)
      : extend();
    void activity?.catch((error) =>
      this.deps.logger.error({ error }, 'Memory activity update failed'),
    );
    if (
      this.closed ||
      event.fatalError ||
      event.generationFailed ||
      event.modelFallbackOccurred
    ) {
      return Promise.resolve();
    }
    return this.serialize(() => this.recorder?.flush() ?? Promise.resolve());
  }

  introspect(): Record<string, unknown> {
    return {
      lastObservedMessageId: this.lastObservedMessageId,
      stepActive: this.stepActive,
      recorder: this.recorder?.introspect() ?? null,
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

  private serialize(action: () => Promise<void>): Promise<void> {
    const result = this.operation.then(action, action);
    this.operation = result.catch(() => undefined);
    return result;
  }
}

/** Maintains episodic memory through deterministic history recording. */
export function createMemoryExt(): ExtensionFactory {
  return {
    identifier: 'io.stagewise/memory',
    displayName: 'Memory',
    create: (deps) => new MemoryExt(deps),
  };
}
