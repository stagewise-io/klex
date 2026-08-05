import {
  type AudioFrame,
  type AudioSource,
  type AudioSourceMetadata,
  cloneAudioFrame,
  type MediaTransport,
  type MediaTransportConnector,
  type RealtimeEndpointClosure,
  type RealtimeProcessor,
  type RealtimeProcessorFactory,
} from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';

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

interface DeterministicAudioSource extends AudioSource {
  inject(frame: AudioFrame): Promise<void>;
  close(reason?: string): void;
  fail(error: unknown): void;
}

interface DeterministicMediaTransport extends MediaTransport {
  readonly closeCount: number;
  addSource(
    id: string,
    metadata?: AudioSourceMetadata,
  ): Promise<DeterministicAudioSource>;
  inject(frame: AudioFrame): Promise<void>;
  receiveSent(): Promise<AudioFrame>;
  remoteClose(reason?: string): void;
  fail(error: unknown): void;
}

class DeterministicAudioSourceModule implements DeterministicAudioSource {
  private readonly queue: BoundedAsyncQueue<AudioFrame>;
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private settled = false;

  readonly readable;
  readonly closed = this.closure.promise;

  constructor(
    readonly id: string,
    readonly metadata: AudioSourceMetadata,
    capacity: number,
  ) {
    this.queue = new BoundedAsyncQueue(capacity);
    this.readable = this.queue;
  }

  inject(frame: AudioFrame): Promise<void> {
    return this.queue.push(cloneAudioFrame(frame));
  }

  close(reason?: string): void {
    this.settle({ type: 'closed', reason });
  }

  fail(error: unknown): void {
    this.settle({ type: 'failed', error }, error);
  }

  private settle(closure: RealtimeEndpointClosure, error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.close(error);
    this.closure.resolve(closure);
  }
}

class DeterministicMediaTransportModule implements DeterministicMediaTransport {
  private readonly sourceQueue = new BoundedAsyncQueue<AudioSource>(16);
  private readonly sentQueue: BoundedAsyncQueue<AudioFrame>;
  private readonly sources = new Map<string, DeterministicAudioSourceModule>();
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly defaultSource: DeterministicAudioSourceModule;
  private settled = false;
  private closes = 0;

  readonly audioSources = this.sourceQueue;
  readonly audioOutput = {
    write: (frame: AudioFrame) => this.writeAudio(frame),
  };
  readonly closed = this.closure.promise;

  constructor(
    private readonly signal?: AbortSignal,
    private readonly capacity = 1,
  ) {
    this.sentQueue = new BoundedAsyncQueue(capacity);
    this.defaultSource = this.createSource('default-audio', {
      participantId: 'deterministic-participant',
      trackId: 'default-audio',
    });
    void this.sourceQueue.push(this.defaultSource);
    signal?.addEventListener('abort', this.handleAbort, { once: true });
    if (signal?.aborted) this.handleAbort();
  }

  get closeCount(): number {
    return this.closes;
  }

  inject(frame: AudioFrame): Promise<void> {
    return this.defaultSource.inject(frame);
  }

  async addSource(
    id: string,
    metadata: AudioSourceMetadata = {
      participantId: `participant-${id}`,
      trackId: id,
    },
  ): Promise<DeterministicAudioSource> {
    if (this.sources.has(id))
      throw new Error(`Audio source already exists: ${id}`);
    const source = this.createSource(id, Object.freeze({ ...metadata }));
    await this.sourceQueue.push(source);
    return source;
  }

  private createSource(
    id: string,
    metadata: AudioSourceMetadata,
  ): DeterministicAudioSourceModule {
    const source = new DeterministicAudioSourceModule(
      id,
      metadata,
      this.capacity,
    );
    this.sources.set(id, source);
    void source.closed.then(() => this.sources.delete(id));
    return source;
  }

  private async writeAudio(frame: AudioFrame): Promise<void> {
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

  private settle(closure: RealtimeEndpointClosure, error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.signal?.removeEventListener('abort', this.handleAbort);
    this.sourceQueue.close(error);
    for (const source of this.sources.values()) {
      if (closure.type === 'failed') source.fail(closure.error);
      else source.close(closure.reason);
    }
    this.sentQueue.close(error);
    this.closure.resolve(closure);
  }
}

function createDeterministicMediaTransport(options?: {
  signal?: AbortSignal;
  capacity?: number;
}): DeterministicMediaTransport {
  return new DeterministicMediaTransportModule(
    options?.signal,
    options?.capacity,
  );
}

interface DeterministicMediaTransportConnector extends MediaTransportConnector {
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

  async close(): Promise<void> {}
}

export function createDeterministicMediaTransportConnector(): DeterministicMediaTransportConnector {
  return new DeterministicMediaTransportConnectorModule();
}

interface DeterministicEchoProcessor extends RealtimeProcessor {
  readonly closeCount: number;
  fail(error: unknown): void;
}

class DeterministicEchoProcessorModule implements DeterministicEchoProcessor {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly activeSources = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private settled = false;
  private closes = 0;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly closed = this.closure.promise;

  constructor(private readonly signal?: AbortSignal) {
    signal?.addEventListener('abort', this.handleAbort, { once: true });
    if (signal?.aborted) this.handleAbort();
  }

  get closeCount(): number {
    return this.closes;
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
    void task.catch((error: unknown) => this.fail(error));
  }

  private async consume(source: AudioSource): Promise<void> {
    for await (const frame of source.readable) {
      if (this.settled) return;
      await this.outputQueue.push(cloneAudioFrame(frame));
    }
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

  private settle(closure: RealtimeEndpointClosure, error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.signal?.removeEventListener('abort', this.handleAbort);
    this.outputQueue.close(error);
    this.closure.resolve(closure);
  }
}

interface DeterministicEchoProcessorFactory extends RealtimeProcessorFactory {
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
