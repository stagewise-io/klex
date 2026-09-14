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
  lastStartMs: number;
}

export const GPT_LIVE_GROUP_GAP_MS = 750;

const DEFAULT_MAX_SEEN_EVENT_IDS = 4_096;
const DEFAULT_MAX_PENDING_GROUPS = 256;
export const GPT_LIVE_MAX_TRANSCRIPT_DELTA_CHARACTERS = 32_000;

const DEFAULT_MAX_GROUP_CHARACTERS = GPT_LIVE_MAX_TRANSCRIPT_DELTA_CHARACTERS;
const DEFAULT_MAX_GROUP_DURATION_MS = 30_000;

export interface GPTLiveTranscriptGrouperOptions {
  readonly maxSeenEventIds?: number;
  readonly maxPendingGroups?: number;
  readonly maxGroupCharacters?: number;
  readonly maxGroupDurationMs?: number;
}

export interface GPTLiveTranscriptGrouper {
  add(fragment: GPTLiveTranscriptFragment): readonly GPTLiveTranscriptGroup[];
  flush(): readonly GPTLiveTranscriptGroup[];
}

class GPTLiveTranscriptGrouperModule implements GPTLiveTranscriptGrouper {
  private readonly active = new Map<'user' | 'assistant', MutableGroup>();
  private readonly pending: MutableGroup[] = [];
  private readonly seen = new Map<string, undefined>();
  private readonly maxSeenEventIds: number;
  private readonly maxPendingGroups: number;
  private readonly maxGroupCharacters: number;
  private readonly maxGroupDurationMs: number;
  private lastEmittedStartMs = Number.NEGATIVE_INFINITY;

  constructor(options: GPTLiveTranscriptGrouperOptions) {
    this.maxSeenEventIds = positiveInteger(
      options.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS,
      'maxSeenEventIds',
    );
    this.maxPendingGroups = positiveInteger(
      options.maxPendingGroups ?? DEFAULT_MAX_PENDING_GROUPS,
      'maxPendingGroups',
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
    if (fragment.delta.length > this.maxGroupCharacters)
      throw new Error(
        'GPT-Live transcript delta exceeds group character limit',
      );
    if (this.seen.has(fragment.eventId)) return [];
    this.seen.set(fragment.eventId, undefined);
    while (this.seen.size > this.maxSeenEventIds) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    if (fragment.startMs < this.lastEmittedStartMs) return [];
    const current = this.active.get(fragment.speaker);
    if (
      current !== undefined &&
      fragment.startMs >= current.lastStartMs &&
      fragment.startMs - current.endMs <= GPT_LIVE_GROUP_GAP_MS &&
      fragment.endMs - current.startMs <= this.maxGroupDurationMs &&
      current.text.length + fragment.delta.length <= this.maxGroupCharacters
    ) {
      current.text += fragment.delta;
      current.endMs = Math.max(current.endMs, fragment.endMs);
      current.lastStartMs = fragment.startMs;
      return [];
    }
    if (current !== undefined) this.enqueuePending(current);
    this.active.set(fragment.speaker, {
      eventId: `gpt-live:transcript:${fragment.speaker}:${fragment.eventId}`,
      speaker: fragment.speaker,
      text: fragment.delta,
      startMs: fragment.startMs,
      endMs: fragment.endMs,
      lastStartMs: fragment.startMs,
    });
    if (current === undefined || fragment.startMs < current.lastStartMs)
      return [];

    const earliestPendingStart = Math.min(
      ...this.pending.map((group) => group.startMs),
    );
    for (const [speaker, group] of this.active) {
      if (speaker === fragment.speaker || group.startMs > earliestPendingStart)
        continue;
      this.active.delete(speaker);
      this.enqueuePending(group);
    }
    const earliestActiveStart = Math.min(
      ...[...this.active.values()].map((group) => group.startMs),
    );
    return this.drainPendingThrough(earliestActiveStart);
  }

  private enqueuePending(group: MutableGroup): void {
    if (this.pending.length >= this.maxPendingGroups)
      throw new Error('GPT-Live pending transcript group limit exceeded');
    this.pending.push(group);
  }

  private drainPendingThrough(
    startMs: number,
  ): readonly GPTLiveTranscriptGroup[] {
    this.pending.sort((left, right) => left.startMs - right.startMs);
    let count = 0;
    while (
      count < this.pending.length &&
      (this.pending[count]?.startMs ?? Number.POSITIVE_INFINITY) <= startMs
    )
      count += 1;
    return this.freezeEmitted(this.pending.splice(0, count));
  }

  flush(): readonly GPTLiveTranscriptGroup[] {
    const groups = [...this.pending.splice(0), ...this.active.values()].sort(
      (left, right) => left.startMs - right.startMs,
    );
    this.active.clear();
    return this.freezeEmitted(groups);
  }

  private freezeEmitted(
    groups: readonly MutableGroup[],
  ): readonly GPTLiveTranscriptGroup[] {
    const last = groups.at(-1);
    if (last !== undefined)
      this.lastEmittedStartMs = Math.max(this.lastEmittedStartMs, last.startMs);
    return groups.map(freeze);
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
  return Object.freeze({
    eventId: group.eventId,
    speaker: group.speaker,
    text: group.text,
    startMs: group.startMs,
    endMs: group.endMs,
  });
}
