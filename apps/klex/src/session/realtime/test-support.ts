import type { LiveKitRoomTransportDescriptor } from '@stagewise/mcp-extension-realtime-media';

import {
  type AudioFrame,
  type AudioSource,
  type AudioSourceMetadata,
  cloneAudioFrame,
  type MediaTransport,
  type MediaTransportConnector,
  type RealtimeEndpointClosure,
} from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';
import type {
  ConversationHost,
  InteractionLeaseClosure,
  InteractionLeaseRequest,
  InteractionToolRequest,
  InteractionToolResult,
  InteractionUpdateEnvelope,
  PreparedInferenceContext,
  PreparedInferenceContextHandle,
  RealtimeCommitEvent,
} from '@/session/interaction';
import { SessionInteractionLease } from '@/session/interaction';
import type {
  RealtimeModelEvent,
  RealtimeModelSession,
  RealtimeModelSessionFactory,
} from '@/session/realtime/model-session';

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

export interface DeterministicMediaTransportConnector
  extends MediaTransportConnector<LiveKitRoomTransportDescriptor> {
  readonly descriptors: readonly LiveKitRoomTransportDescriptor[];
  nextTransport(): Promise<DeterministicMediaTransport>;
}

class DeterministicMediaTransportConnectorModule
  implements DeterministicMediaTransportConnector
{
  private readonly connected: DeterministicMediaTransport[] = [];
  private readonly waiters: Array<
    (transport: DeterministicMediaTransport) => void
  > = [];
  private readonly acceptedDescriptors: LiveKitRoomTransportDescriptor[] = [];

  get descriptors(): readonly LiveKitRoomTransportDescriptor[] {
    return this.acceptedDescriptors;
  }

  async connect(
    descriptor: LiveKitRoomTransportDescriptor,
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

interface DeterministicEchoProcessor extends RealtimeModelSession {
  readonly context: PreparedInferenceContext;
  readonly closeCount: number;
  readonly attachedSources: readonly Pick<AudioSource, 'id' | 'metadata'>[];
  readonly receivedUpdates: readonly InteractionUpdateEnvelope[];
  readonly receivedToolResults: readonly InteractionToolResult[];
  fail(error: unknown): void;
  /** Publishes a semantic model event to the coordinator. */
  emit(event: RealtimeModelEvent): Promise<void>;
}

class DeterministicEchoProcessorModule implements DeterministicEchoProcessor {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly eventQueue = new BoundedAsyncQueue<RealtimeModelEvent>(16);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly activeSources = new Set<string>();
  private readonly acceptedSources: Pick<AudioSource, 'id' | 'metadata'>[] = [];
  private readonly tasks = new Set<Promise<void>>();
  private readonly updates: InteractionUpdateEnvelope[] = [];
  private readonly toolResults: InteractionToolResult[] = [];
  private settled = false;
  private closes = 0;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly events = this.eventQueue;
  readonly closed = this.closure.promise;

  constructor(
    readonly context: PreparedInferenceContext,
    private readonly signal?: AbortSignal,
  ) {
    signal?.addEventListener('abort', this.handleAbort, { once: true });
    if (signal?.aborted) this.handleAbort();
  }

  get closeCount(): number {
    return this.closes;
  }

  get attachedSources(): readonly Pick<AudioSource, 'id' | 'metadata'>[] {
    return this.acceptedSources;
  }

  get receivedUpdates(): readonly InteractionUpdateEnvelope[] {
    return this.updates;
  }

  get receivedToolResults(): readonly InteractionToolResult[] {
    return this.toolResults;
  }

  async emit(event: RealtimeModelEvent): Promise<void> {
    await this.eventQueue.push(event);
  }

  private async attachSource(source: AudioSource): Promise<void> {
    if (this.settled) throw new Error('Processor is closed');
    if (this.activeSources.has(source.id))
      throw new Error(`Audio source already attached: ${source.id}`);
    this.activeSources.add(source.id);
    this.acceptedSources.push({ id: source.id, metadata: source.metadata });
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

  async sendUpdate(update: InteractionUpdateEnvelope): Promise<void> {
    this.updates.push(update);
  }

  async sendToolResult(result: InteractionToolResult): Promise<void> {
    this.toolResults.push(result);
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
    this.eventQueue.close(error);
    this.closure.resolve(closure);
  }
}

interface DeterministicEchoProcessorFactory
  extends RealtimeModelSessionFactory {
  create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
    context: PreparedInferenceContext;
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
    context: PreparedInferenceContext;
  }): Promise<DeterministicEchoProcessor> {
    const processor = new DeterministicEchoProcessorModule(
      options.context,
      options.signal,
    );
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

export interface DeterministicInteractionLease extends SessionInteractionLease {
  readonly commits: readonly RealtimeCommitEvent[];
  readonly toolRequests: readonly InteractionToolRequest[];
  readonly acknowledged: readonly number[];
  readonly contextCommits: number;
  readonly contextRollbacks: number;
  readonly releaseCount: number;
}

export interface DeterministicConversationHost extends ConversationHost {
  readonly requests: readonly InteractionLeaseRequest[];
  nextLease(): Promise<DeterministicInteractionLease>;
  /** Makes every following acquisition reject with `error`. */
  rejectAcquisitions(error: unknown): void;
  /** Models primary-session closure without treating it as a lease release. */
  revokeLeases(
    reason: Extract<InteractionLeaseClosure, { type: 'revoked' }>['reason'],
  ): void;
  setToolHandler(
    handler: (request: InteractionToolRequest) => InteractionToolResult,
  ): void;
}

const DETERMINISTIC_CONTEXT: PreparedInferenceContext = {
  instructions: 'You are Klex.',
  messages: [{ role: 'user', content: 'Hello.' }],
  tools: [],
  model: {
    modelId: 'gpt-realtime',
    contextSize: 32_000,
    inputCapabilities: { audio: {} },
  },
  historyRevision: 1,
  updateWatermark: 0,
};

async function waitForAcquisitionTurn(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    queueMicrotask(() => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    });
  });
}

class DeterministicConversationHostModule
  implements DeterministicConversationHost
{
  private readonly issued: DeterministicInteractionLease[] = [];
  private readonly waiters: Array<
    (lease: DeterministicInteractionLease) => void
  > = [];
  private readonly acquired: InteractionLeaseRequest[] = [];
  private readonly activeLeases = new Set<SessionInteractionLease>();
  private acquisitionError: { error: unknown } | undefined;
  private toolHandler: (
    request: InteractionToolRequest,
  ) => InteractionToolResult = (request) => ({
    executionId: request.executionId,
    status: 'success',
    output: { ok: true },
  });
  private nextId = 0;

  get requests(): readonly InteractionLeaseRequest[] {
    return this.acquired;
  }

  rejectAcquisitions(error: unknown): void {
    this.acquisitionError = { error };
  }

  revokeLeases(
    reason: Extract<InteractionLeaseClosure, { type: 'revoked' }>['reason'],
  ): void {
    for (const lease of this.activeLeases) lease.revoke(reason);
  }

  setToolHandler(
    handler: (request: InteractionToolRequest) => InteractionToolResult,
  ): void {
    this.toolHandler = handler;
  }

  async acquireInteractionLease(
    request: InteractionLeaseRequest,
  ): Promise<DeterministicInteractionLease> {
    this.acquired.push(request);
    if (this.acquisitionError) throw this.acquisitionError.error;
    await waitForAcquisitionTurn(request.signal);
    const commits: RealtimeCommitEvent[] = [];
    const toolRequests: InteractionToolRequest[] = [];
    const acknowledged: number[] = [];
    const counters = { contextCommits: 0, contextRollbacks: 0, releases: 0 };
    this.nextId += 1;
    const lease = new SessionInteractionLease({
      id: `lease-${this.nextId}`,
      sessionId: 'primary-session',
      mode: request.mode,
      bootstrap: async (): Promise<PreparedInferenceContextHandle> => ({
        context: DETERMINISTIC_CONTEXT,
        commit: () => {
          counters.contextCommits += 1;
        },
        rollback: () => {
          counters.contextRollbacks += 1;
        },
      }),
      executeTool: async (toolRequest) => {
        toolRequests.push(toolRequest);
        return this.toolHandler(toolRequest);
      },
      commit: async (event) => {
        commits.push(event);
      },
      onRelease: () => {
        counters.releases += 1;
      },
    });
    this.activeLeases.add(lease);
    void lease.closed.finally(() => this.activeLeases.delete(lease));
    const decorated = Object.defineProperties(lease, {
      commits: { get: () => commits },
      toolRequests: { get: () => toolRequests },
      acknowledged: { get: () => acknowledged },
      contextCommits: { get: () => counters.contextCommits },
      contextRollbacks: { get: () => counters.contextRollbacks },
      releaseCount: { get: () => counters.releases },
    }) as DeterministicInteractionLease;
    const acknowledgeUpdate = lease.acknowledgeUpdate.bind(lease);
    lease.acknowledgeUpdate = (sequence: number) => {
      acknowledged.push(sequence);
      acknowledgeUpdate(sequence);
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter(decorated);
    else this.issued.push(decorated);
    return decorated;
  }

  async nextLease(): Promise<DeterministicInteractionLease> {
    const lease = this.issued.shift();
    if (lease) return lease;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function createDeterministicConversationHost(): DeterministicConversationHost {
  return new DeterministicConversationHostModule();
}

export const DETERMINISTIC_REALTIME_MODEL = DETERMINISTIC_CONTEXT.model;
