import type { CapturedLogEntry } from '@stagewise/logger';

export interface LogStore {
  add(entry: CapturedLogEntry): void;
  getEntries(): readonly CapturedLogEntry[];
  subscribe(listener: () => void): () => void;
}

class LogStoreModule implements LogStore {
  private readonly entries: CapturedLogEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly capacity: number) {}

  add(entry: CapturedLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A viewer subscriber must never disrupt application logging.
      }
    }
  }

  getEntries(): readonly CapturedLogEntry[] {
    return this.entries;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createLogStore(capacity = 500): LogStore {
  return new LogStoreModule(capacity);
}
