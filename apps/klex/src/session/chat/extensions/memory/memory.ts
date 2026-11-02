import { type ToolSet, tool } from 'ai';

import type { ActivityHistory } from '@/activity-history';

import type {
  CheckpointApplyingEvent,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
} from '../extension-api';
import {
  resolveCheckpointCursor,
  type StagedCheckpoint,
} from './checkpoint-cursor';
import {
  createMemoryRetrievalCoordinator,
  type MemoryRetrievalCoordinator,
  RecallRejectedError,
  recallInputSchema,
  renderObservation,
} from './retrieval';
import systemPromptPart from './system-prompt-part.md';

/** Observation batches sent per step; the rest drains on later steps. */
const MAX_OBSERVATION_BATCHES_PER_STEP = 4;

export interface MemoryExtOptions {
  activities: ActivityHistory;
}

class MemoryExt implements Extension {
  private retrievalCoordinator: MemoryRetrievalCoordinator | null = null;
  private closed = false;
  /** Retrieval observation cursor; independent of the recorder cursor. */
  private lastObservedMessageId: string | null = null;
  private stagedCheckpoint: StagedCheckpoint | null = null;
  // onStepComplete settles this guard on both normal and throwing steps.
  private stepActive = false;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: MemoryExtOptions,
  ) {}

  async onStart(): Promise<void> {
    if (this.retrievalCoordinator || this.closed) return;
    const window = this.deps.getHistory();
    this.lastObservedMessageId = window.at(-1)?.id ?? null;
    this.retrievalCoordinator = createMemoryRetrievalCoordinator(
      this.deps,
      this.options.activities,
    );
    await this.retrievalCoordinator.start();
    this.deps.logger.info('Memory extension started');
  }

  async onClose(): Promise<void> {
    this.closed = true;
    await this.retrievalCoordinator?.close();
    this.retrievalCoordinator = null;
    this.deps.logger.info('Memory extension closed');
  }

  getTools(): ToolSet {
    const coordinator = this.retrievalCoordinator;
    if (!coordinator) return {};
    return {
      recall: tool({
        description:
          'Ask memory in the background. Answers arrive later in `<memory>` blocks, including when I remember nothing. Meanwhile continue silently unless memory is strictly required. Optional scope is a context hint for the app, conversation, person, or project, not an enforced filter or authorization boundary. Prefer known IDs, e.g. "slack conversation:C123 user:U456"; prose such as "GitHub stagewise-io/klex PR #222" or "Julian\'s work on deployment previews" also works. Never invent IDs; omit scope when unknown.',
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
    return Promise.resolve();
  }

  /** Preserve the live retriever's cursor across canonical checkpoints. */
  onCheckpointApplying(event: CheckpointApplyingEvent): undefined {
    if (this.closed) return;
    this.stagedCheckpoint = event;
    this.observeDelta();
    return undefined;
  }

  introspect(): Record<string, unknown> {
    return {
      lastObservedMessageId: this.lastObservedMessageId,
      stepActive: this.stepActive,
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
        this.lastObservedMessageId = resolveCheckpointCursor(
          this.lastObservedMessageId,
          history,
          this.stagedCheckpoint,
        );
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
}

/** Retrieves retained activity and observes the live default session. */
export function createMemoryExt(options: MemoryExtOptions): ExtensionFactory {
  return {
    identifier: 'io.stagewise/memory',
    displayName: 'Memory',
    create: (deps) => new MemoryExt(deps, options),
  };
}
