import { createHash, randomBytes } from 'node:crypto';

/**
 * Maximum recorded generations per exported `gen_ai.conversation.id` before
 * rolling over to a fresh epoch suffix. Sized well below Grafana Agent
 * Observability / Sigil's unpaginated conversation query crash threshold.
 */
export const MAX_GENERATIONS_PER_CONVERSATION = 100;

/**
 * Inactivity gap (45 minutes) after which the next generation opens a fresh
 * exported `gen_ai.conversation.id` epoch. Also gives Grafana's
 * whole-conversation evaluations an idle boundary on which to settle.
 */
export const CONVERSATION_IDLE_GAP_MS = 45 * 60 * 1_000;

/** Maximum byte/character length for `gen_ai.conversation.id` (Sigil VARCHAR(255)). */
export const MAX_CONVERSATION_ID_LENGTH = 255;

const HOUSEKEEPING_EXTENSION_IDS = new Set([
  'io.stagewise/context-compaction',
  'context-compaction',
  'io.stagewise/episode-summary',
  'episode-summary',
  'core:instinct-classifier',
]);

/**
 * True for background housekeeping extensions whose LLM calls should remain
 * visible in Tempo traces and local usage accounting without bloating or
 * cluttering Grafana Agent Observability user conversations.
 */
export function isBackgroundHousekeepingExtension(
  extensionId: string | null | undefined,
): boolean {
  return extensionId != null && HOUSEKEEPING_EXTENSION_IDS.has(extensionId);
}

/**
 * Deterministically bounds `gen_ai.conversation.id` to
 * {@link MAX_CONVERSATION_ID_LENGTH} characters while preserving entropy from
 * the trailing epoch suffix.
 */
export function boundConversationIdLength(value: string): string {
  if (value.length <= MAX_CONVERSATION_ID_LENGTH) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  const prefixBudget = MAX_CONVERSATION_ID_LENGTH - hash.length - 1;
  return `${value.slice(0, prefixBudget)}:${hash}`;
}

export interface ConversationEpochOptions {
  /** Maximum generations per conversation epoch before rollover. */
  maxGenerations?: number;
  /** Idle duration (ms) between generations before rollover. */
  idleGapMs?: number;
  /** Initial epoch key used before any checkpoint exists. */
  initialEpochId?: string;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Rollover suffix generator override for deterministic tests. */
  createSuffix?: () => string;
}

export interface RestoreConversationWindowOptions {
  /** Durable checkpoint header ID from the restored window, if present. */
  checkpointId?: string;
  /** Number of assistant generations already persisted in the restored tail. */
  restoredGenerations: number;
  /** Epoch ms timestamp of the latest persisted message in the window, if known. */
  lastActivityAt?: number | null;
}

/**
 * Tracks a bounded conversation epoch suffix for long-lived Klex sessions
 * (the default session and `memory-retrieval` child sessions).
 *
 * Rotates whenever:
 * 1. A compaction checkpoint header is applied (`onCheckpointApplied`),
 * 2. Recorded generations in the current epoch reach `maxGenerations`, or
 * 3. Idle time since the last generation reaches `idleGapMs`.
 */
export interface ConversationEpochTracker {
  /** Pure read of the active epoch identifier (does not increment counts). */
  currentEpochId(): string;
  /**
   * Seed state from a restored durable session window. Continues the restored
   * checkpoint's primary epoch across a quick restart when still within the
   * count and idle bounds; otherwise rolls over immediately so restarts never
   * pile into an old or full conversation.
   */
  restoreFromWindow(options: RestoreConversationWindowOptions): string;
  /** Rotate to a new compaction checkpoint header ID and reset counters. */
  onCheckpointApplied(checkpointId: string): string;
  /**
   * Advance the tracker for a new recorded generation, rolling over first if
   * the generation cap or idle gap has been reached.
   */
  beginGeneration(): string;
}

function defaultSuffix(): string {
  return randomBytes(4).toString('hex');
}

function defaultInitialEpochId(): string {
  return randomBytes(6).toString('hex');
}

class ConversationEpochTrackerImpl implements ConversationEpochTracker {
  private readonly maxGenerations: number;
  private readonly idleGapMs: number;
  private readonly now: () => number;
  private readonly createSuffix: () => string;

  private baseEpochId: string;
  private rolloverSuffix: string | null = null;
  private generationCount = 0;
  private lastActivityAt: number | null = null;

  constructor(options: ConversationEpochOptions = {}) {
    this.maxGenerations = Math.max(
      1,
      Math.floor(options.maxGenerations ?? MAX_GENERATIONS_PER_CONVERSATION),
    );
    this.idleGapMs = Math.max(
      1,
      Math.floor(options.idleGapMs ?? CONVERSATION_IDLE_GAP_MS),
    );
    this.now = options.now ?? Date.now;
    this.createSuffix = options.createSuffix ?? defaultSuffix;
    this.baseEpochId = options.initialEpochId || defaultInitialEpochId();
  }

  currentEpochId(): string {
    return this.rolloverSuffix
      ? `${this.baseEpochId}:${this.rolloverSuffix}`
      : this.baseEpochId;
  }

  restoreFromWindow(options: RestoreConversationWindowOptions): string {
    if (!options.checkpointId) {
      // Without a persisted checkpoint, keep the fresh per-boot epoch id so
      // pre-checkpoint restarts never pile up into an unbounded bucket.
      this.rolloverSuffix = null;
      this.generationCount = 0;
      this.lastActivityAt = null;
      return this.currentEpochId();
    }

    this.baseEpochId = options.checkpointId;
    const restoredGenerations = Math.max(
      0,
      Math.floor(options.restoredGenerations),
    );
    const lastActivityAt =
      options.lastActivityAt != null && Number.isFinite(options.lastActivityAt)
        ? options.lastActivityAt
        : null;
    const now = this.now();
    const overCap = restoredGenerations >= this.maxGenerations;
    const idleExpired =
      lastActivityAt !== null && now - lastActivityAt >= this.idleGapMs;

    if (overCap || idleExpired) {
      this.rolloverSuffix = this.nextDistinctSuffix();
      this.generationCount = 0;
      this.lastActivityAt = null;
    } else {
      this.rolloverSuffix = null;
      this.generationCount = restoredGenerations;
      this.lastActivityAt = lastActivityAt;
    }
    return this.currentEpochId();
  }

  onCheckpointApplied(checkpointId: string): string {
    this.baseEpochId = checkpointId;
    this.rolloverSuffix = null;
    this.generationCount = 0;
    this.lastActivityAt = null;
    return this.currentEpochId();
  }

  beginGeneration(): string {
    const now = this.now();
    const idleExpired =
      this.lastActivityAt !== null &&
      now - this.lastActivityAt >= this.idleGapMs;
    const countExceeded = this.generationCount >= this.maxGenerations;

    if (idleExpired || countExceeded) {
      this.rolloverSuffix = this.nextDistinctSuffix();
      this.generationCount = 0;
    }

    this.generationCount += 1;
    this.lastActivityAt = now;
    return this.currentEpochId();
  }

  private nextDistinctSuffix(): string {
    const previous = this.rolloverSuffix;
    let candidate = this.createSuffix();
    if (previous !== null && candidate === previous) {
      candidate = this.createSuffix();
    }
    return candidate;
  }
}

export function createConversationEpochTracker(
  options?: ConversationEpochOptions,
): ConversationEpochTracker {
  return new ConversationEpochTrackerImpl(options);
}
