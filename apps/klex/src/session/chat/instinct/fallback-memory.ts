/**
 * Process-global memory of the instinct candidate that last succeeded.
 * Latency belongs to the model, not the session, so all sessions (including
 * subagents) share it. Keyed by the ordered candidate list: any selection
 * change starts over with the first model.
 */
export interface InstinctFallbackMemory {
  /** Start index for this list; touches the idle clock. */
  start(key: string, resetIdleMs: number, now?: number): number;
  /** Records the candidate index that produced a result. */
  succeeded(key: string, index: number): void;
  /** Test hook. */
  clear(): void;
}

interface Entry {
  index: number;
  lastUsedAt: number;
}

class InstinctFallbackMemoryModule implements InstinctFallbackMemory {
  private entry: (Entry & { key: string }) | undefined;

  start(key: string, resetIdleMs: number, now = Date.now()): number {
    const entry = this.entry;
    const index =
      entry && entry.key === key && now - entry.lastUsedAt <= resetIdleMs
        ? entry.index
        : 0;
    this.entry = { key, index, lastUsedAt: now };
    return index;
  }

  succeeded(key: string, index: number): void {
    if (this.entry?.key === key) this.entry.index = index;
    else this.entry = { key, index, lastUsedAt: Date.now() };
  }

  clear(): void {
    this.entry = undefined;
  }
}

export function createInstinctFallbackMemory(): InstinctFallbackMemory {
  return new InstinctFallbackMemoryModule();
}

/** Shared by every chat session in this process. */
export const instinctFallbackMemory = createInstinctFallbackMemory();
