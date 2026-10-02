import type { InstinctHistoryDelta } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

/** A computed delta plus the baseline it would establish once accepted. */
export interface PendingInstinctDelta {
  readonly delta: InstinctHistoryDelta;
  readonly snapshotIds: ReadonlySet<string>;
}

/**
 * Tracks the message-ID baseline of the previous instinct of one session.
 * The delta is based on ID sets, not array length, so messages inserted
 * mid-history (`insertMessageAfter`) are detected. The baseline advances
 * only through {@link accept}, so an aborted instinct does not lose delta.
 */
export class InstinctHistoryDeltaTracker {
  private baseline: ReadonlySet<string> | null = null;

  compute(history: readonly ExtendedUIMessage[]): PendingInstinctDelta {
    const snapshotIds = new Set(history.map(({ id }) => id));
    const baseline = this.baseline;
    if (baseline === null) {
      return {
        delta: { added: [...history], removedIds: [], initial: true },
        snapshotIds,
      };
    }
    const added = history.filter(({ id }) => !baseline.has(id));
    const removedIds = [...baseline].filter((id) => !snapshotIds.has(id));
    return { delta: { added, removedIds, initial: false }, snapshotIds };
  }

  /**
   * Makes the snapshot the new baseline. Messages committed by the same
   * instinct are deliberately not included, so they appear in the next
   * step's delta and extensions can confirm what actually landed.
   */
  accept(pending: PendingInstinctDelta): void {
    this.baseline = pending.snapshotIds;
  }
}
