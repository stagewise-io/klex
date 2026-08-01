import { BoundedAsyncQueue } from '../async-queue';
import {
  type AudioFrame,
  cloneAudioFrame,
  type RealtimeAudioProcessor,
  type RealtimeAudioProcessorClosure,
  type RealtimeAudioProcessorFactory,
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

class LoopbackProcessor implements RealtimeAudioProcessor {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly closure = deferred<RealtimeAudioProcessorClosure>();
  private settled = false;

  readonly output: AsyncIterable<AudioFrame> = this.outputQueue;
  readonly closed = this.closure.promise;

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.handleAbort, { once: true });
    if (signal.aborted) this.handleAbort();
  }

  writeInput(frame: AudioFrame): Promise<void> {
    return this.outputQueue.push(cloneAudioFrame(frame));
  }

  async close(): Promise<void> {
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private readonly handleAbort = (): void => {
    this.settle({ type: 'closed', reason: 'aborted' });
  };

  private settle(closure: RealtimeAudioProcessorClosure): void {
    if (this.settled) return;
    this.settled = true;
    this.signal.removeEventListener('abort', this.handleAbort);
    this.outputQueue.close();
    this.closure.resolve(closure);
  }
}

class LoopbackProcessorFactory implements RealtimeAudioProcessorFactory {
  async create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<RealtimeAudioProcessor> {
    return new LoopbackProcessor(options.signal);
  }
}

export function createLoopbackProcessorFactory(): RealtimeAudioProcessorFactory {
  return new LoopbackProcessorFactory();
}
