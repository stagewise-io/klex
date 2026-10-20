import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { SessionKind } from '@/session/types';

/** Static metadata of one `ChatSession` instance. */
export interface SessionHistoryRecorderMetadata {
  /** Unique per `ChatSession` instance; stable for its lifetime. */
  instanceId: string;
  /** Logical session id (`'default'` is reused across replacements). */
  sessionId: string;
  kind: SessionKind;
  name: string;
  parentInstanceId?: string;
  extensionIdentifier?: string;
  /** ISO timestamp of the instance creation. */
  createdAt: string;
}

/**
 * Write handle for one session instance. Messages are addressed by ID:
 * new IDs are appended to the session log with the next `ord`, changed
 * content is rewritten in place, and IDs that disappear from the window are
 * deleted unless they were announced via {@link markTrimmed}.
 *
 * All methods except {@link commitCheckpoint} are non-throwing: store
 * failures are logged and retried on the next sync.
 */
export interface SessionHistoryRecorder {
  readonly instanceId: string;
  /**
   * Schedule a transcript sync. Calls are coalesced; the getter is invoked
   * when the sync runs, so it must return the current message window.
   */
  scheduleSync(getMessages: () => readonly ExtendedUIMessage[]): void;
  /**
   * Register a restored window as already persisted. Must be called before
   * the first sync.
   */
  seed(window: SessionHistoryWindow): void;
  /**
   * Announce that these messages leave the in-memory window without being
   * deleted from the log. Call synchronously before removing them.
   */
  markTrimmed(messageIds: readonly string[]): void;
  /**
   * Sync `getMessages()`, then durably append `header` as a checkpoint
   * covering every logged message up to `coversThroughMessageId`. The header
   * is expected to enter the window right after this resolves. Rejects when
   * the write fails or the anchor is not persisted.
   */
  commitCheckpoint(
    header: ExtendedUIMessage,
    coversThroughMessageId: string,
    getMessages: () => readonly ExtendedUIMessage[],
  ): Promise<void>;
  /** Run a final sync and mark the instance as ended. Never rejects. */
  end(reason: string): Promise<void>;
}

/** One persisted message of a restored window. */
export interface SessionHistoryWindowEntry {
  message: ExtendedUIMessage;
  ord: number;
  instanceId: string;
  isCheckpoint: boolean;
  /** SHA-1 of the stored content, used to detect later changes. */
  hash: string;
}

/**
 * The restorable window of a logical session: the latest checkpoint header
 * (if any) followed by all later non-checkpoint messages in `ord` order.
 */
export interface SessionHistoryWindow {
  entries: SessionHistoryWindowEntry[];
  /** True when the window starts with a checkpoint header. */
  hasCheckpoint: boolean;
}

export interface SessionHistoryWindowQuery {
  /**
   * Byte budget for sessions without a checkpoint: the newest messages up
   * to this size are restored.
   */
  fallbackMaxBytes: number;
}

export interface SessionHistoryRecord {
  instanceId: string;
  sessionId: string;
  kind: SessionKind;
  name: string;
  parentInstanceId: string | null;
  extensionIdentifier: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  endReason: string | null;
  live: boolean;
  /** Logical number of messages, including trimmed ones. */
  messageCount: number;
  /** Number of leading messages removed by size-cap enforcement. */
  trimmedMessageCount: number;
  /** Stored bytes of the retained messages. */
  byteSize: number;
}

export interface SessionHistoryListQuery {
  kind?: SessionKind;
  parentInstanceId?: string;
  live?: boolean;
  limit: number;
  /** Opaque cursor returned as `nextCursor` by a previous page. */
  cursor?: string;
}

export interface SessionHistoryListPage {
  sessions: SessionHistoryRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SessionHistoryMessagesQuery {
  limit: number;
  /** Return messages with `seq < beforeSeq`. Omit for the newest page. */
  beforeSeq?: number;
}

export interface SessionHistoryMessage {
  /**
   * Log position (`ord`) within the logical session. Increasing, not
   * contiguous: rollbacks and other instances leave gaps.
   */
  seq: number;
  persistedAt: string;
  message: ExtendedUIMessage;
}

export interface SessionHistoryMessagesPage {
  /** Chronological (oldest first) page. */
  messages: SessionHistoryMessage[];
  /** Pass as `beforeSeq` to load the previous (older) page. */
  nextCursor: number | null;
  hasMore: boolean;
  trimmedMessageCount: number;
}
