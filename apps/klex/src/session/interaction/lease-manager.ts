import { randomUUID } from 'node:crypto';

import type { ModuleLogger } from '@stagewise/logger';

import type { SessionInboxEvent } from '@/session/inbox';

import { SessionInteractionLease } from './interaction-lease';
import type {
  InteractionLease,
  InteractionLeaseRequest,
  InteractionToolRequest,
  InteractionToolResult,
  PreparedInferenceContextHandle,
  RealtimeCommitEvent,
} from './types';

/**
 * Thrown when a lease is requested while another interaction mode already
 * owns the generation lane. The generation lane is mutually exclusive: the
 * chat loop and a realtime call must never generate concurrently.
 */
export class GenerationLaneUnavailableError extends Error {
  constructor(readonly holderId: string) {
    super(
      `The generation lane is already leased by interaction ${holderId}. Release it before acquiring a new lease.`,
    );
    this.name = 'GenerationLaneUnavailableError';
    Object.setPrototypeOf(this, GenerationLaneUnavailableError.prototype);
  }
}

export class GenerationLaneClosedError extends Error {
  constructor() {
    super('The primary session is closed — no lease can be acquired.');
    this.name = 'GenerationLaneClosedError';
    Object.setPrototypeOf(this, GenerationLaneClosedError.prototype);
  }
}

/**
 * Capabilities the primary chat session must provide so a leased
 * interaction mode can run on canonical session state.
 */
export interface GenerationLaneHost {
  readonly sessionId: string;
  /**
   * Stops the chat generation lane at its next commit boundary and
   * resolves once no chat generation is in flight.
   */
  quiesceGenerationLane(reason: string): Promise<void>;
  /** Re-enables the chat generation lane after a lease ended. */
  resumeGenerationLane(): void;
  /** Prepares canonical context (instructions, history, tools) for the lease. */
  prepareContext(
    request: InteractionLeaseRequest,
  ): Promise<PreparedInferenceContextHandle>;
  /** Executes a tool through the shared session tool runtime. */
  executeTool(request: InteractionToolRequest): Promise<InteractionToolResult>;
  /** Clears tool and context state owned by the ending lease. */
  finalizeLease(): void;
  /** Persists realtime activity into canonical history. */
  commit(event: RealtimeCommitEvent): Promise<void>;
}

export class GenerationLaneLeaseManager {
  private active: SessionInteractionLease | null = null;
  private acquisition: Promise<InteractionLease> | null = null;
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly deps: {
      host: GenerationLaneHost;
      logger: ModuleLogger;
      maxPendingUpdates?: number;
    },
  ) {}

  get holder(): InteractionLease | null {
    return this.active;
  }

  isLeased(): boolean {
    return this.active !== null;
  }

  get updateWatermark(): number {
    return this.sequence;
  }

  async acquire(request: InteractionLeaseRequest): Promise<InteractionLease> {
    if (this.closed) throw new GenerationLaneClosedError();
    if (this.active) throw new GenerationLaneUnavailableError(this.active.id);
    if (this.acquisition) {
      const pending = await this.acquisition;
      throw new GenerationLaneUnavailableError(pending.id);
    }

    this.acquisition = this.acquireOnce(request);
    try {
      return await this.acquisition;
    } finally {
      this.acquisition = null;
    }
  }

  private async acquireOnce(
    request: InteractionLeaseRequest,
  ): Promise<InteractionLease> {
    const leaseId = randomUUID();
    const handoffStartedAt = Date.now();
    await this.deps.host.quiesceGenerationLane(`interaction-lease:${leaseId}`);
    const handoffDurationMs = Date.now() - handoffStartedAt;

    if (this.closed) throw new GenerationLaneClosedError();
    if (request.signal.aborted) {
      this.deps.host.resumeGenerationLane();
      throw new Error('Lease acquisition aborted before the lease was issued.');
    }

    const lease = new SessionInteractionLease({
      id: leaseId,
      sessionId: this.deps.host.sessionId,
      mode: request.mode,
      ...(this.deps.maxPendingUpdates !== undefined && {
        maxPendingUpdates: this.deps.maxPendingUpdates,
      }),
      bootstrap: () => this.deps.host.prepareContext(request),
      executeTool: (toolRequest) => this.deps.host.executeTool(toolRequest),
      commit: (event) => this.deps.host.commit(event),
      onRelease: (reason) => this.finalize(lease, reason),
    });

    const onAbort = () => lease.revoke('primary-session-closed');
    request.signal.addEventListener('abort', onAbort, { once: true });
    lease.closed.then((closure) => {
      request.signal.removeEventListener('abort', onAbort);
      if (closure.type !== 'released') {
        this.finalize(
          lease,
          closure.type === 'revoked' ? closure.reason : 'lease-failed',
        );
      }
    });

    this.active = lease;
    this.deps.logger.info(
      {
        sessionId: this.deps.host.sessionId,
        leaseId,
        mode: request.mode,
        externalSessionId: request.externalSessionId,
        handoffDurationMs,
      },
      'Generation lane leased to interaction mode',
    );
    return lease;
  }

  /**
   * Forwards an inbox event to the active lease. Returns true when the
   * lease consumed the event, false when the chat loop must handle it.
   */
  forward(event: SessionInboxEvent, requestResponse: boolean): boolean {
    if (!this.active) return false;
    this.sequence += 1;
    return this.active.publish({
      sequence: this.sequence,
      // Preserve the canonical event identity (MCP eventId when present) so
      // replay after reconnect cannot duplicate an already-handled input.
      eventId: event.eventId ?? randomUUID(),
      event,
      requestResponse,
    });
  }

  revoke(
    reason: 'primary-session-closed' | 'primary-session-terminated',
  ): void {
    this.closed = true;
    this.active?.revoke(reason);
    this.active = null;
  }

  private finalize(
    lease: SessionInteractionLease,
    releaseReason?: string,
  ): void {
    if (this.active !== lease) return;
    this.active = null;
    this.deps.host.finalizeLease();
    if (!this.closed) this.deps.host.resumeGenerationLane();
    this.deps.logger.info(
      {
        sessionId: this.deps.host.sessionId,
        leaseId: lease.id,
        releaseReason,
      },
      'Generation lane lease ended — chat lane resumed',
    );
  }
}
