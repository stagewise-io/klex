import type { ExtendedUIMessage } from '@/session/chat/message-types';

export type HistoryMessage = ExtendedUIMessage;
export type HistoryRole = ExtendedUIMessage['role'];

/**
 * - `end`: keep the head, total length equals `max` (`…` included).
 * - `middle`: keep head and tail, total length equals `max`.
 * - `end-overflow`: keep `max` head characters and append `…`.
 */
export type TruncateStyle = 'end' | 'middle' | 'end-overflow';

export interface FieldLimit {
  max: number;
  truncate: TruncateStyle;
}

/**
 * - `plain`: strings verbatim, other values via `JSON.stringify`.
 * - `compact`: strings verbatim, other values via node- and string-bounded
 *   JSON that never throws.
 * - `lines`: strings verbatim, other values as bounded `key: value` lines
 *   with dotted paths.
 */
export type JsonMode = 'plain' | 'compact' | 'lines';

export interface ValueLimit extends FieldLimit {
  json: JsonMode;
}

/** Projects a `data-{key}` part to a labelled value, or drops it (`null`). */
export type DataProjector = (
  data: unknown,
) => { label: string; value: string } | null;

/** Stage 1: decides which parts become records and how fields are bounded. */
export interface HistoryFilterOptions {
  /** Messages with other roles project to zero records. Default: all. */
  roles?: readonly HistoryRole[];
  skipMessage?: (message: HistoryMessage) => boolean;
  text:
    | false
    | {
        roles: readonly HistoryRole[];
        limit: FieldLimit;
        keepEmpty?: boolean;
      };
  reasoning: false | { limit: FieldLimit };
  tools:
    | false
    | {
        name?: FieldLimit;
        input: false | ValueLimit;
        output: false | ValueLimit;
        error: false | FieldLimit;
        skip?: (toolName: string) => boolean;
      };
  context:
    | false
    | {
        source?: FieldLimit;
        metadata: false | ValueLimit;
        text: FieldLimit;
        keepEmptyText?: boolean;
        /**
         * Resource-link and embedded-resource items: `placeholder` keeps the
         * kind only, `{ limit }` keeps uri, name, and text, each bounded.
         */
        resources: 'placeholder' | { limit: FieldLimit };
        /** `inline` keeps base64 data, `placeholder` the MIME type only. */
        media: 'inline' | 'placeholder';
      };
  summary: false | { key: string; limit: FieldLimit };
  /** Projectors for `data-{key}` parts; other data parts are dropped. */
  data?: Readonly<Record<string, DataProjector>>;
}

export type ToolStatus = 'pending' | 'succeeded' | 'failed' | 'denied';

export type ContextItem =
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'audio'; mimeType: string; data?: string }
  | { kind: 'resource_link'; uri?: string; name?: string }
  | { kind: 'resource'; uri?: string; text?: string };

export type HistoryRecord =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool';
      name: string;
      status: ToolStatus;
      input?: string;
      output?: string;
      error?: string;
    }
  | { kind: 'context'; source: string; metadata?: string; items: ContextItem[] }
  | { kind: 'summary'; text: string }
  | { kind: 'data'; label: string; value: string };

export interface ProjectedMessage {
  id: string;
  role: HistoryRole;
  hasSummary: boolean;
  records: HistoryRecord[];
}

export type HistorySegment =
  | { type: 'text'; text: string }
  | {
      type: 'media';
      kind: 'image' | 'audio';
      mediaType: string;
      data: string;
    };

export interface RenderedMessage {
  text: string;
  /** Interleaved text/media. */
  segments: HistorySegment[];
}

/** Stage 2: per-message size limits of the line renderer. */
export interface LineRendererOptions {
  /** Max rendered length of one message; adds a `[… N more parts]` line. */
  messageLimit?: number;
  /** Max rendered length of one context record; adds `[… N more items]`. */
  contextLimit?: number;
}

/**
 * Stage 3: aggregate budget over rendered messages.
 *
 * - `newest`: keeps the latest summary (when the filter projects summaries)
 *   plus the newest ordinary messages after it, prefixed by the truncation
 *   marker when anything was dropped. Yields text segments only.
 * - `oldest`: keeps messages in order until the next one would exceed the
 *   budget. The returned cursor points at the last consumed message.
 */
export type HistoryBudget =
  | { keep: 'newest'; maxCharacters?: number; recentMessageLimit?: number }
  | { keep: 'oldest'; maxCharacters: number };

export type HistoryScope =
  | { kind: 'all' }
  /** Messages after `cursor`; the whole history if the id is not found. */
  | { kind: 'after-cursor'; cursor: string | null };

export interface HistoryViewOptions {
  filter: HistoryFilterOptions;
  lines?: LineRendererOptions;
  /** Omitted: every non-empty message in scope, no limit. */
  budget?: HistoryBudget;
}

export interface RenderedHistory {
  text: string;
  segments: HistorySegment[];
  /** Id to resume from with an `after-cursor` scope. */
  cursor: string | null;
  truncated: boolean;
}

export interface HistoryView {
  render(
    history: readonly HistoryMessage[],
    scope?: HistoryScope,
  ): RenderedHistory;
}
