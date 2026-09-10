interface QueueReader<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
}

interface QueueWriter<T> {
  value: T;
  resolve(): void;
  reject(error: unknown): void;
}

/** Internal bounded multi-producer, single-consumer async queue. */
export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly readers: QueueReader<T>[] = [];
  private readonly writers: QueueWriter<T>[] = [];
  private ended = false;
  private failure: unknown;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('Queue capacity must be a positive integer');
  }

  async push(value: T): Promise<void> {
    if (this.ended) throw this.closedError();
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ value, done: false });
      return;
    }
    if (this.items.length < this.capacity) {
      this.items.push(value);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.writers.push({ value, resolve, reject });
    });
  }

  close(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    const closedError = this.closedError();
    for (const writer of this.writers.splice(0)) writer.reject(closedError);
    for (const reader of this.readers.splice(0)) {
      if (error === undefined) reader.resolve({ value: undefined, done: true });
      else reader.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const pendingReaders = new Set<QueueReader<T>>();
    let returned = false;
    return {
      next: async () => {
        if (returned) return { value: undefined, done: true };
        let pendingReader: QueueReader<T> | undefined;
        try {
          return await this.next((reader) => {
            pendingReader = reader;
            pendingReaders.add(reader);
          });
        } finally {
          if (pendingReader) pendingReaders.delete(pendingReader);
        }
      },
      return: async () => {
        returned = true;
        for (const reader of pendingReaders) this.cancelReader(reader);
        return { value: undefined, done: true };
      },
    };
  }

  private async next(
    onPending: (reader: QueueReader<T>) => void,
  ): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift() as T;
      this.promoteWriter();
      return { value, done: false };
    }
    if (this.ended) {
      if (this.failure !== undefined) throw this.failure;
      return { value: undefined, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const reader = { resolve, reject };
      this.readers.push(reader);
      onPending(reader);
    });
  }

  private cancelReader(reader: QueueReader<T>): void {
    const index = this.readers.indexOf(reader);
    if (index < 0) return;
    this.readers.splice(index, 1);
    reader.resolve({ value: undefined, done: true });
  }

  private promoteWriter(): void {
    const writer = this.writers.shift();
    if (!writer) return;
    const reader = this.readers.shift();
    if (reader) reader.resolve({ value: writer.value, done: false });
    else this.items.push(writer.value);
    writer.resolve();
  }

  private closedError(): unknown {
    return this.failure ?? new Error('Queue is closed');
  }
}
