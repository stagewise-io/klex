export interface GPTLiveTranscriptFragment {
  readonly eventId: string;
  readonly speaker: 'user' | 'assistant';
  readonly delta: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface GPTLiveTranscriptGroup {
  readonly eventId: string;
  readonly speaker: 'user' | 'assistant';
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface MutableGroup {
  eventId: string;
  speaker: 'user' | 'assistant';
  text: string;
  startMs: number;
  endMs: number;
}

export const GPT_LIVE_GROUP_GAP_MS = 750;

const DEFAULT_MAX_SEEN_EVENT_IDS = 4_096;
const DEFAULT_MAX_GROUP_CHARACTERS = 32_000;
const DEFAULT_MAX_GROUP_DURATION_MS = 30_000;

export interface GPTLiveTranscriptGrouperOptions {
  readonly maxSeenEventIds?: number;
  readonly maxGroupCharacters?: number;
  readonly maxGroupDurationMs?: number;
}

export interface GPTLiveTranscriptGrouper {
  add(fragment: GPTLiveTranscriptFragment): readonly GPTLiveTranscriptGroup[];
  flush(): readonly GPTLiveTranscriptGroup[];
}

class GPTLiveTranscriptGrouperModule implements GPTLiveTranscriptGrouper {
  private readonly active = new Map<'user' | 'assistant', MutableGroup>();
  private readonly seen = new Map<string, undefined>();
  private readonly maxSeenEventIds: number;
  private readonly maxGroupCharacters: number;
  private readonly maxGroupDurationMs: number;

  constructor(options: GPTLiveTranscriptGrouperOptions) {
    this.maxSeenEventIds = positiveInteger(
      options.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS,
      'maxSeenEventIds',
    );
    this.maxGroupCharacters = positiveInteger(
      options.maxGroupCharacters ?? DEFAULT_MAX_GROUP_CHARACTERS,
      'maxGroupCharacters',
    );
    this.maxGroupDurationMs = positiveInteger(
      options.maxGroupDurationMs ?? DEFAULT_MAX_GROUP_DURATION_MS,
      'maxGroupDurationMs',
    );
  }

  add(fragment: GPTLiveTranscriptFragment): readonly GPTLiveTranscriptGroup[] {
    if (this.seen.has(fragment.eventId)) return [];
    this.seen.set(fragment.eventId, undefined);
    while (this.seen.size > this.maxSeenEventIds) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    const current = this.active.get(fragment.speaker);
    if (
      current !== undefined &&
      fragment.startMs >= current.startMs &&
      fragment.startMs - current.endMs <= GPT_LIVE_GROUP_GAP_MS &&
      fragment.endMs - current.startMs <= this.maxGroupDurationMs &&
      current.text.length + fragment.delta.length <= this.maxGroupCharacters
    ) {
      current.text += fragment.delta;
      current.endMs = Math.max(current.endMs, fragment.endMs);
      return [];
    }
    this.active.set(fragment.speaker, {
      eventId: `gpt-live:transcript:${fragment.speaker}:${fragment.eventId}`,
      speaker: fragment.speaker,
      text: fragment.delta,
      startMs: fragment.startMs,
      endMs: fragment.endMs,
    });
    return current === undefined ? [] : [freeze(current)];
  }

  flush(): readonly GPTLiveTranscriptGroup[] {
    const groups = [...this.active.values()]
      .sort((left, right) => left.startMs - right.startMs)
      .map(freeze);
    this.active.clear();
    return groups;
  }
}

export function createGPTLiveTranscriptGrouper(
  options: GPTLiveTranscriptGrouperOptions = {},
): GPTLiveTranscriptGrouper {
  return new GPTLiveTranscriptGrouperModule(options);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function freeze(group: MutableGroup): GPTLiveTranscriptGroup {
  return Object.freeze({ ...group });
}
