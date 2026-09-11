import type {
  InteractionLease,
  InteractionLeaseClosure,
  InteractionMode,
  InteractionToolRequest,
  InteractionToolResult,
  InteractionUpdateEnvelope,
  PreparedInferenceContextHandle,
  RealtimeCommitEvent,
} from './types';

const DEFAULT_MAX_PENDING_UPDATES = 256;

interface PendingRead {
  readonly iteratorId: symbol;
  resolve(result: IteratorResult<InteractionUpdateEnvelope>): void;
}

export interface SessionInteractionLeaseDependencies {
  id: string;
  sessionId: string;
  mode: InteractionMode;
  bootstrap(): Promise<PreparedInferenceContextHandle>;
  executeTool(request: InteractionToolRequest): Promise<InteractionToolResult>;
  commit(event: RealtimeCommitEvent): Promise<void>;
  onRelease(reason?: string): Promise<void> | void;
  maxPendingUpdates?: number;
}

export class SessionInteractionLease implements InteractionLease {
  readonly id: string;
  readonly sessionId: string;
  readonly mode: InteractionMode;
  readonly closed: Promise<InteractionLeaseClosure>;
  readonly updates: AsyncIterable<InteractionUpdateEnvelope>;

  private readonly queue: InteractionUpdateEnvelope[] = [];
  private readonly readers: PendingRead[] = [];
  private readonly committedEventIds = new Set<string>();
  private readonly maxPendingUpdates: number;
  private commitWork: Promise<void> = Promise.resolve();
  private releaseWork: Promise<void> | undefined;
  private acceptingCommits = true;
  private resolveClosed!: (closure: InteractionLeaseClosure) => void;
  private closure: InteractionLeaseClosure | null = null;
  private highestAcknowledgedSequence = 0;

  constructor(private readonly deps: SessionInteractionLeaseDependencies) {
    this.id = deps.id;
    this.sessionId = deps.sessionId;
    this.mode = deps.mode;
    this.maxPendingUpdates =
      deps.maxPendingUpdates ?? DEFAULT_MAX_PENDING_UPDATES;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.updates = {
      [Symbol.asyncIterator]: () => {
        const iteratorId = Symbol('interaction-update-iterator');
        return {
          next: () => this.nextUpdate(iteratorId),
          return: () => this.closeIterator(iteratorId),
        };
      },
    };
  }

  async bootstrap(): Promise<PreparedInferenceContextHandle> {
    const handle = await this.deps.bootstrap();
    // Updates at or below the context watermark are already represented in
    // the bootstrap snapshot and must not also reach the live model stream.
    if (handle.context.updateWatermark > this.highestAcknowledgedSequence) {
      this.acknowledgeUpdate(handle.context.updateWatermark);
    }
    return handle;
  }

  acknowledgeUpdate(sequence: number): void {
    this.highestAcknowledgedSequence = Math.max(
      this.highestAcknowledgedSequence,
      sequence,
    );
    while (
      this.queue[0] &&
      this.queue[0].sequence <= this.highestAcknowledgedSequence
    ) {
      this.queue.shift();
    }
  }

  executeTool(request: InteractionToolRequest): Promise<InteractionToolResult> {
    return this.deps.executeTool(request);
  }

  commit(event: RealtimeCommitEvent): Promise<void> {
    if (!this.acceptingCommits || this.committedEventIds.has(event.eventId))
      return Promise.resolve();
    this.committedEventIds.add(event.eventId);
    const run = this.commitWork.then(() => this.deps.commit(event));
    this.commitWork = run.catch(() => {
      this.committedEventIds.delete(event.eventId);
    });
    return run;
  }

  release(reason?: string, finalEvent?: RealtimeCommitEvent): Promise<void> {
    if (!this.releaseWork) {
      this.releaseWork = this.releaseOnce(reason, finalEvent);
    }
    return this.releaseWork;
  }

  publish(update: InteractionUpdateEnvelope): boolean {
    if (this.closure || update.sequence <= this.highestAcknowledgedSequence) {
      return false;
    }
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ done: false, value: update });
      return true;
    }
    this.queue.push(update);
    if (this.queue.length > this.maxPendingUpdates) {
      this.revoke('update-overflow');
      return false;
    }
    return true;
  }

  revoke(
    reason: Extract<InteractionLeaseClosure, { type: 'revoked' }>['reason'],
  ): void {
    if (this.closure) return;
    this.finish({ type: 'revoked', reason });
  }

  fail(error: unknown): void {
    if (this.closure) return;
    this.finish({ type: 'failed', error });
  }

  private async releaseOnce(
    reason: string | undefined,
    finalEvent: RealtimeCommitEvent | undefined,
  ): Promise<void> {
    if (this.closure) return;
    this.acceptingCommits = false;
    await this.commitWork;
    if (this.closure) return;

    let finalCommitError: unknown;
    if (finalEvent && !this.committedEventIds.has(finalEvent.eventId)) {
      this.committedEventIds.add(finalEvent.eventId);
      try {
        await this.deps.commit(finalEvent);
      } catch (error) {
        this.committedEventIds.delete(finalEvent.eventId);
        finalCommitError = error;
      }
    }

    // Revocation owns closure and cleanup if it wins while commit work drains.
    if (this.closure) return;
    this.finish({ type: 'released', ...(reason !== undefined && { reason }) });
    await this.deps.onRelease(reason);
    if (finalCommitError !== undefined) throw finalCommitError;
  }

  private nextUpdate(
    iteratorId: symbol,
  ): Promise<IteratorResult<InteractionUpdateEnvelope>> {
    const update = this.queue.shift();
    if (update) return Promise.resolve({ done: false, value: update });
    if (this.closure) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.readers.push({ iteratorId, resolve }));
  }

  private closeIterator(
    iteratorId: symbol,
  ): Promise<IteratorResult<InteractionUpdateEnvelope>> {
    for (let index = this.readers.length - 1; index >= 0; index -= 1) {
      const reader = this.readers[index];
      if (reader?.iteratorId !== iteratorId) continue;
      this.readers.splice(index, 1);
      reader.resolve({ done: true, value: undefined });
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  private finish(closure: InteractionLeaseClosure): void {
    this.acceptingCommits = false;
    this.closure = closure;
    this.queue.splice(0);
    this.resolveClosed(closure);
    for (const reader of this.readers.splice(0)) {
      reader.resolve({ done: true, value: undefined });
    }
  }
}
