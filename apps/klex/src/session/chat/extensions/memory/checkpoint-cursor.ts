import type { ExtendedUIMessage } from '../../message-types';
import type { CheckpointApplyingEvent } from '../extension-api';

/**
 * A checkpoint announced by `onCheckpointApplying`. Core may still abort or
 * defer it, so cursors are not moved eagerly; they resolve through it once
 * the trim actually happened.
 */
export type StagedCheckpoint = CheckpointApplyingEvent;

/**
 * Resolves a window cursor against a staged checkpoint. A cursor still in
 * the window stays. A cursor the checkpoint trimmed moves to its header
 * once that header is in the window, so after-cursor scoping covers
 * exactly the surviving tail.
 */
export function resolveCheckpointCursor(
  cursor: string | null,
  history: readonly ExtendedUIMessage[],
  staged: StagedCheckpoint | null,
): string | null {
  if (cursor === null || !staged) return cursor;
  if (!staged.droppedMessageIds.includes(cursor)) return cursor;
  if (history.some((message) => message.id === cursor)) return cursor;
  if (!history.some((message) => message.id === staged.checkpointMessageId)) {
    return cursor;
  }
  return staged.checkpointMessageId;
}
