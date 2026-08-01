import { BoundedAsyncQueue } from '../async-queue';
import {
  type AudioFrame,
  cloneAudioFrame,
  type MediaTransport,
  type MediaTransportClosure,
  type MediaTransportConnector,
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

export interface DeterministicMediaTransport extends MediaTransport {
  readonly closeCount: number;
  inject(frame: AudioFrame): Promise<void>;
  receiveSent(): Promise<AudioFrame>;
  remoteClose(reason?: string): void;
  fail(error: unknown): void;
}

class DeterministicMediaTransportModule implements DeterministicMediaTransport {
  private readonly incomingQueue: BoundedAsyncQueue<AudioFrame>;
  private readonly sentQueue: BoundedAsyncQueue<AudioFrame>;
  private readonly closure = deferred<MediaTransportClosure>();
  private settled = false;
  private closes = 0;

  readonly incoming: AsyncIterable<AudioFrame>;
  readonly closed = this.closure.promise;

  constructor(
    private readonly signal?: AbortSignal,
    capacity = 1,
  ) {
    this.incomingQueue = new BoundedAsyncQueue(capacity);
    this.sentQueue = new BoundedAsyncQueue(capacity);
    this.incoming = this.incomingQueue;
    signal?.addEventListener('abort', this.handleAbort, { once: true });
    if (signal?.aborted) this.handleAbort();
  }

  get closeCount(): number {
    return this.closes;
  }

  async inject(frame: AudioFrame): Promise<void> {
    await this.incomingQueue.push(cloneAudioFrame(frame));
  }

  async send(frame: AudioFrame): Promise<void> {
    await this.sentQueue.push(cloneAudioFrame(frame));
  }

  async receiveSent(): Promise<AudioFrame> {
    const result = await this.sentQueue[Symbol.asyncIterator]().next();
    if (result.done) throw new Error('Transport is closed');
    return result.value;
  }

  remoteClose(reason?: string): void {
    this.settle({ type: 'closed', reason });
  }

  fail(error: unknown): void {
    this.settle({ type: 'failed', error }, error);
  }

  async close(): Promise<void> {
    if (this.closes > 0) return;
    this.closes += 1;
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private readonly handleAbort = (): void => {
    void this.close();
  };

  private settle(closure: MediaTransportClosure, error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.signal?.removeEventListener('abort', this.handleAbort);
    this.incomingQueue.close(error);
    this.sentQueue.close(error);
    this.closure.resolve(closure);
  }
}

export function createDeterministicMediaTransport(options?: {
  signal?: AbortSignal;
  capacity?: number;
}): DeterministicMediaTransport {
  return new DeterministicMediaTransportModule(
    options?.signal,
    options?.capacity,
  );
}

export interface DeterministicMediaTransportConnector
  extends MediaTransportConnector {
  readonly descriptors: readonly unknown[];
  nextTransport(): Promise<DeterministicMediaTransport>;
}

class DeterministicMediaTransportConnectorModule
  implements DeterministicMediaTransportConnector
{
  private readonly connected: DeterministicMediaTransport[] = [];
  private readonly waiters: Array<
    (transport: DeterministicMediaTransport) => void
  > = [];
  private readonly acceptedDescriptors: unknown[] = [];

  get descriptors(): readonly unknown[] {
    return this.acceptedDescriptors;
  }

  async connect(
    descriptor: unknown,
    options: { signal: AbortSignal },
  ): Promise<DeterministicMediaTransport> {
    if (options.signal.aborted) throw options.signal.reason;
    this.acceptedDescriptors.push(structuredClone(descriptor));
    const transport = createDeterministicMediaTransport({
      signal: options.signal,
    });
    const waiter = this.waiters.shift();
    if (waiter) waiter(transport);
    else this.connected.push(transport);
    return transport;
  }

  async nextTransport(): Promise<DeterministicMediaTransport> {
    const transport = this.connected.shift();
    if (transport) return transport;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function createDeterministicMediaTransportConnector(): DeterministicMediaTransportConnector {
  return new DeterministicMediaTransportConnectorModule();
}

export interface DeterministicEchoProcessor extends RealtimeAudioProcessor {
  readonly closeCount: number;
  fail(error: unknown): void;
}

class DeterministicEchoProcessorModule implements DeterministicEchoProcessor {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly closure = deferred<RealtimeAudioProcessorClosure>();
  private settled = false;
  private closes = 0;

  readonly output: AsyncIterable<AudioFrame> = this.outputQueue;
  readonly closed = this.closure.promise;

  constructor(private readonly signal?: AbortSignal) {
    signal?.addEventListener('abort', this.handleAbort, { once: true });
    if (signal?.aborted) this.handleAbort();
  }

  get closeCount(): number {
    return this.closes;
  }

  async writeInput(frame: AudioFrame): Promise<void> {
    await this.outputQueue.push(cloneAudioFrame(frame));
  }

  fail(error: unknown): void {
    this.settle({ type: 'failed', error }, error);
  }

  async close(): Promise<void> {
    if (this.closes > 0) return;
    this.closes += 1;
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private readonly handleAbort = (): void => {
    void this.close();
  };

  private settle(
    closure: RealtimeAudioProcessorClosure,
    error?: unknown,
  ): void {
    if (this.settled) return;
    this.settled = true;
    this.signal?.removeEventListener('abort', this.handleAbort);
    this.outputQueue.close(error);
    this.closure.resolve(closure);
  }
}

export interface DeterministicEchoProcessorFactory
  extends RealtimeAudioProcessorFactory {
  create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<DeterministicEchoProcessor>;
  nextProcessor(): Promise<DeterministicEchoProcessor>;
}

class DeterministicEchoProcessorFactoryModule
  implements DeterministicEchoProcessorFactory
{
  private readonly created: DeterministicEchoProcessor[] = [];
  private readonly waiters: Array<
    (processor: DeterministicEchoProcessor) => void
  > = [];

  async create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<DeterministicEchoProcessor> {
    const processor = new DeterministicEchoProcessorModule(options.signal);
    const waiter = this.waiters.shift();
    if (waiter) waiter(processor);
    else this.created.push(processor);
    return processor;
  }

  async nextProcessor(): Promise<DeterministicEchoProcessor> {
    const processor = this.created.shift();
    if (processor) return processor;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function createDeterministicEchoProcessorFactory(): DeterministicEchoProcessorFactory {
  return new DeterministicEchoProcessorFactoryModule();
}
