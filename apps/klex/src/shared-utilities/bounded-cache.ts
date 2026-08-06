import type { FilePart, TextPart } from 'ai';

/**
 * Size-bounded cache. Evicts oldest entries (FIFO — Map preserves
 * insertion order) when total estimated size exceeds maxBytes.
 * Prevents unbounded memory growth across sessions.
 */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  private totalSize = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly estimateSize: (value: V) => number,
  ) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.totalSize -= this.estimateSize(this.map.get(key) as V);
    }
    this.totalSize += this.estimateSize(value);
    this.map.set(key, value);

    while (this.totalSize > this.maxBytes && this.map.size > 1) {
      const firstKey = this.map.keys().next().value;
      if (firstKey === undefined) break;
      this.totalSize -= this.estimateSize(this.map.get(firstKey) as V);
      this.map.delete(firstKey);
    }
  }

  clear(): void {
    this.map.clear();
    this.totalSize = 0;
  }

  get size(): number {
    return this.map.size;
  }
}

/** Estimates the byte size of a FilePart or TextPart for cache accounting. */
export function estimatePartSize(part: FilePart | TextPart): number {
  if (part.type === 'text') return part.text.length;
  const data = part.data;
  if (typeof data === 'string') return data.length;
  if (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    data.type === 'data' &&
    'data' in data &&
    typeof data.data === 'string'
  ) {
    return data.data.length;
  }
  return 1024; // Fallback for URL/reference parts
}
