import { randomUUID } from 'node:crypto';

import type { Span } from '@opentelemetry/api';

import type { ModuleLogger } from '@stagewise/logger';

import { escapeXml } from '@/session/chat/utils/escape-xml';
import { CONTEXT_SUMMARY_KEY } from '@/session/chat/utils/history-view';
import type { SessionHistoryRecorder } from '@/session-history';

import type { ExtensionHandler } from '../extension-handler';
import {
  type CheckpointCommitRequest,
  type CheckpointCommitResult,
  createDataPart,
  type DataPartTransformers,
  dataPartTransformer,
  isDataPartOf,
} from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';

/**
 * Consecutive deferrals after which a pending checkpoint is applied anyway,
 * so a failing extension cannot reintroduce unbounded window growth.
 */
export const MAX_CHECKPOINT_DEFERRALS = 3;

/** Data of the summary part that opens a checkpoint header. */
export interface CheckpointSummaryData {
  summary: string;
  /** Absent on headers migrated from legacy compaction summaries. */
  coversThroughMessageId?: string;
}

/** True when the message carries a checkpoint summary part. */
export function isCheckpointHeader(
  message: ExtendedUIMessage | undefined,
): boolean {
  return (
    message?.parts.some((part) => isDataPartOf(CONTEXT_SUMMARY_KEY, part)) ??
    false
  );
}

/** Core renderer for the header summary part. */
export const CHECKPOINT_DATA_PART_TRANSFORMERS: DataPartTransformers = {
  [CONTEXT_SUMMARY_KEY]: dataPartTransformer<CheckpointSummaryData>((data) => [
    { type: 'text', text: `<summary>${escapeXml(data.summary)}</summary>` },
  ]),
};

/**
 * What one {@link CheckpointManager.applyPending} call did. Callers outside
 * the turn loop use it to decide whether an immediate retry is safe:
 * `changed` (and a pending commit after `applied`/`rejected`) is a settled
 * race, while `deferred` and `failed` must wait for the next boundary so a
 * failing extension cannot burn through its deferral budget.
 */
export type CheckpointApplyOutcome =
  /** Nothing pending, closed, or another apply is in flight. */
  | 'none'
  | 'applied'
  | 'rejected'
  | 'deferred'
  /** The window prefix changed during the hooks; still pending. */
  | 'changed'
  /** Carry collection or persistence threw; still pending. */
  | 'failed'
  /** The owner tore down mid-apply; nothing was persisted. */
  | 'abandoned';

export interface CheckpointManager {
  /** Validate and queue a checkpoint for the next safe boundary. */
  commit(request: CheckpointCommitRequest): CheckpointCommitResult;
  /** True while a validated checkpoint waits for a boundary. */
  readonly hasPending: boolean;
  /** True while the checkpoint for this anchor waits for a boundary. */
  isPending(anchorId: string): boolean;
  /**
   * Apply the pending checkpoint, if any. Call only at a step boundary,
   * when nothing else mutates the window. Never rejects.
   */
  applyPending(): Promise<CheckpointApplyOutcome>;
  /** Resolves once the in-flight apply, if any, has finished. */
  whenSettled(): Promise<void>;
}

export interface CheckpointManagerDependencies {
  logger: ModuleLogger;
  span: Span;
  /** The live window. Mutated in place; never replaced. */
  messages: ExtendedUIMessage[];
  extensionHandler: () => Pick<
    ExtensionHandler,
    'collectCheckpointCarry' | 'runCheckpointApplyingHooks'
  >;
  recorder?: SessionHistoryRecorder;
  /** Called after the window was trimmed. */
  onApplied?: () => void;
  /** No new apply starts once this returns true. */
  isClosed?: () => boolean;
  /**
   * An in-flight apply stops before persisting once this returns true.
   * Distinct from {@link isClosed} so the owner can let an apply that
   * already started finish during shutdown.
   */
  isAbandoned?: () => boolean;
}

type ValidationResult =
  | { ok: true; anchorIndex: number }
  | { ok: false; reason: string };

class CheckpointManagerModule implements CheckpointManager {
  private pending: CheckpointCommitRequest | null = null;
  private deferrals = 0;
  private inFlight: Promise<CheckpointApplyOutcome> | null = null;

  constructor(private readonly deps: CheckpointManagerDependencies) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  isPending(anchorId: string): boolean {
    return this.pending?.coversThroughMessageId === anchorId;
  }

  commit(request: CheckpointCommitRequest): CheckpointCommitResult {
    const validation = this.validate(request.coversThroughMessageId);
    if (!validation.ok) {
      this.reject(request, validation.reason);
      return { status: 'rejected', reason: validation.reason };
    }
    const replaced = this.pending !== null;
    this.pending = { ...request };
    this.deferrals = 0;
    this.deps.span.addEvent('checkpoint.committed', {
      'klex.checkpoint.anchor_id': request.coversThroughMessageId,
      'klex.checkpoint.replaced_pending': replaced,
    });
    this.deps.logger.info(
      {
        anchorId: request.coversThroughMessageId,
        replacedPending: replaced,
      },
      'Checkpoint committed — pending until next step boundary',
    );
    return { status: 'pending' };
  }

  applyPending(): Promise<CheckpointApplyOutcome> {
    if (!this.pending || this.inFlight) return Promise.resolve('none');
    if (this.deps.isClosed?.()) return Promise.resolve('none');
    const run = this.applyGuarded(this.pending);
    this.inFlight = run;
    return run;
  }

  async whenSettled(): Promise<void> {
    await this.inFlight;
  }

  private async applyGuarded(
    request: CheckpointCommitRequest,
  ): Promise<CheckpointApplyOutcome> {
    try {
      return await this.applyUnlocked(request);
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Checkpoint apply failed — keeping it pending',
      );
      this.deps.span.addEvent('checkpoint.apply_failed', {
        error: String(error),
      });
      return 'failed';
    } finally {
      this.inFlight = null;
    }
  }

  private async applyUnlocked(
    request: CheckpointCommitRequest,
  ): Promise<CheckpointApplyOutcome> {
    const { messages } = this.deps;
    const anchorId = request.coversThroughMessageId;

    const validation = this.validate(anchorId);
    if (!validation.ok) {
      this.clearPending(request);
      this.reject(request, validation.reason);
      return 'rejected';
    }

    const dropped = messages.slice(0, validation.anchorIndex + 1);
    const droppedMessageIds = dropped.map((message) => message.id);

    // A throw aborts this apply; applyPending keeps the request pending.
    const carry = await this.deps
      .extensionHandler()
      .collectCheckpointCarry(dropped);

    const header: ExtendedUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [
        createDataPart(CONTEXT_SUMMARY_KEY, {
          summary: request.summary,
          coversThroughMessageId: anchorId,
        } satisfies CheckpointSummaryData),
        ...carry,
      ] as ExtendedUIMessage['parts'],
    };

    const { defer } = await this.deps
      .extensionHandler()
      .runCheckpointApplyingHooks({
        droppedMessageIds,
        checkpointMessageId: header.id,
      });
    if (defer) {
      this.deferrals += 1;
      if (this.deferrals < MAX_CHECKPOINT_DEFERRALS) {
        this.deps.span.addEvent('checkpoint.deferred', {
          'klex.checkpoint.anchor_id': anchorId,
          'klex.checkpoint.deferrals': this.deferrals,
        });
        this.deps.logger.info(
          { anchorId, deferrals: this.deferrals },
          'Checkpoint deferred by an extension',
        );
        return 'deferred';
      }
      this.deps.logger.warn(
        { anchorId, deferrals: this.deferrals },
        'Checkpoint deferred too often — applying anyway',
      );
    }

    if (this.deps.isAbandoned?.()) return 'abandoned';

    // The hooks may have yielded; make sure the window prefix is unchanged
    // before persisting a header for it.
    const current = this.validate(anchorId);
    if (!current.ok) {
      this.clearPending(request);
      this.reject(request, current.reason);
      return 'rejected';
    }
    if (!samePrefix(messages, droppedMessageIds, current.anchorIndex)) {
      this.deps.logger.info(
        { anchorId },
        'Window changed during checkpoint apply — retrying',
      );
      return 'changed';
    }

    // Durable first: a crash after this point restores the new window.
    await this.deps.recorder?.commitCheckpoint(
      header,
      anchorId,
      () => this.deps.messages,
    );

    // Normally the anchor index. If the anchor was rolled back while the
    // header was written, trim the remaining covered prefix instead.
    const droppedSet = new Set(droppedMessageIds);
    const anchorIndex = messages.findLastIndex((m) => droppedSet.has(m.id));
    if (messages[anchorIndex]?.id !== anchorId) {
      this.deps.logger.warn(
        { anchorId },
        'Checkpoint anchor disappeared during persistence',
      );
    }
    const trimmed = messages.slice(0, anchorIndex + 1).map((m) => m.id);
    this.deps.recorder?.markTrimmed(trimmed);
    messages.splice(0, anchorIndex + 1, header);

    this.clearPending(request);
    this.deferrals = 0;
    this.deps.span.addEvent('checkpoint.applied', {
      'klex.checkpoint.id': header.id,
      'klex.checkpoint.anchor_id': anchorId,
      'klex.checkpoint.dropped_count': trimmed.length,
      'klex.checkpoint.carry_part_count': carry.length,
      'klex.checkpoint.window_length': messages.length,
    });
    this.deps.logger.info(
      {
        checkpointId: header.id,
        anchorId,
        droppedCount: trimmed.length,
        carryPartCount: carry.length,
        windowLength: messages.length,
      },
      'Checkpoint applied — window trimmed',
    );
    this.deps.onApplied?.();
    return 'applied';
  }

  private validate(anchorId: string): ValidationResult {
    const { messages } = this.deps;
    const anchorIndex = messages.findIndex((m) => m.id === anchorId);
    if (anchorIndex === -1) {
      return { ok: false, reason: 'anchor is not in the window' };
    }
    if (anchorIndex === 0 && isCheckpointHeader(messages[0])) {
      return { ok: false, reason: 'anchor is the current checkpoint header' };
    }
    const hasTail = messages
      .slice(anchorIndex + 1)
      .some((message) => !isCheckpointHeader(message));
    if (!hasTail) {
      return { ok: false, reason: 'no message follows the anchor' };
    }
    return { ok: true, anchorIndex };
  }

  private clearPending(request: CheckpointCommitRequest): void {
    if (this.pending === request) this.pending = null;
  }

  private reject(request: CheckpointCommitRequest, reason: string): void {
    this.deps.span.addEvent('checkpoint.rejected', {
      'klex.checkpoint.anchor_id': request.coversThroughMessageId,
      'klex.checkpoint.reason': reason,
    });
    this.deps.logger.warn(
      { anchorId: request.coversThroughMessageId, reason },
      'Checkpoint rejected',
    );
  }
}

function samePrefix(
  messages: readonly ExtendedUIMessage[],
  ids: readonly string[],
  anchorIndex: number,
): boolean {
  if (anchorIndex + 1 !== ids.length) return false;
  return ids.every((id, index) => messages[index]?.id === id);
}

export function createCheckpointManager(
  deps: CheckpointManagerDependencies,
): CheckpointManager {
  return new CheckpointManagerModule(deps);
}
