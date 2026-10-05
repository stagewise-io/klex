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
 * Write handle for one session instance. All methods are non-throwing:
 * store failures are logged and retried on the next sync.
 */
export interface SessionHistoryRecorder {
  readonly instanceId: string;
  /**
   * Schedule a transcript sync. Calls are coalesced; the getter is invoked
   * when the sync runs and by admission safety checks, so it must be pure
   * and return the current message array.
   */
  scheduleSync(getMessages: () => readonly ExtendedUIMessage[]): void;
  /** Run a final sync and mark the instance as ended. Never rejects. */
  end(reason: string): Promise<void>;
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
