import { BoundedAsyncQueue } from '../async-queue';
import {
  type AudioFrame,
  type AudioSource,
  cloneAudioFrame,
  type RealtimeEndpointClosure,
  type RealtimeProcessor,
  type RealtimeProcessorFactory,
} from '../media-transport';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class LoopbackProcessor implements RealtimeProcessor {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly activeSources = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private settled = false;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly closed = this.closure.promise;

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.handleAbort, { once: true });
    if (signal.aborted) this.handleAbort();
  }

  private async attachSource(source: AudioSource): Promise<void> {
    if (this.settled) throw new Error('Processor is closed');
    if (this.activeSources.has(source.id))
      throw new Error(`Audio source already attached: ${source.id}`);
    this.activeSources.add(source.id);
    const task = this.consume(source).finally(() => {
      this.activeSources.delete(source.id);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    void task.catch((error: unknown) =>
      this.settle({ type: 'failed', error }, error),
    );
  }

  private async consume(source: AudioSource): Promise<void> {
    for await (const frame of source.readable) {
      if (this.settled) return;
      await this.outputQueue.push(cloneAudioFrame(frame));
    }
  }

  async close(): Promise<void> {
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private readonly handleAbort = (): void => {
    this.settle({ type: 'closed', reason: 'aborted' });
  };

  private settle(closure: RealtimeEndpointClosure, error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.signal.removeEventListener('abort', this.handleAbort);
    this.outputQueue.close(error);
    this.closure.resolve(closure);
  }
}

class LoopbackProcessorFactory implements RealtimeProcessorFactory {
  async create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<RealtimeProcessor> {
    return new LoopbackProcessor(options.signal);
  }
}

export function createLoopbackProcessorFactory(): RealtimeProcessorFactory {
  return new LoopbackProcessorFactory();
}
