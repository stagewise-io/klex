import type { ContentBlock } from '@modelcontextprotocol/client';

/** Which MCP extension an inbound event arrived through. */
export type InboundEventOrigin = 'push-notifications' | 'events';

/**
 * Settles one delivered event with its origin. Push Notifications acknowledge
 * the `eventId` on the server; Events commit the subscription cursor. Callers
 * only invoke it once the agent finished handling the event.
 */
export interface DeliveryReceipt {
  settle(): Promise<void>;
}

/** Origin-neutral event shape handed to the session layer. */
export interface InboundEvent {
  namespace: string;
  origin: InboundEventOrigin;
  /**
   * Scope of `eventId` uniqueness. Push: the identity queue. Events: the
   * subscription (name plus canonical arguments).
   */
  sourceKey: string;
  eventId: string;
  type: string;
  data?: unknown;
  content?: ContentBlock[];
  receipt: DeliveryReceipt;
}

/**
 * A producer of inbound events. The Mcp module aggregates every registered
 * source for quiescence flushing and pausing, so sources behave equally above
 * the transport layer.
 */
export interface InboundEventSource {
  readonly origin: InboundEventOrigin;
  /** Delivered to listeners but not yet settled. */
  hasUnsettled(): boolean;
  /** Settles everything delivered so far. */
  settleDelivered(): Promise<void>;
  /** Stops new deliveries for the process lifetime; delivered events may still settle. */
  pause(): void;
}

/** Dedup key shared by all origins; `eventId` is only unique within a source. */
export function inboundEventKey(
  event: Pick<InboundEvent, 'namespace' | 'origin' | 'sourceKey' | 'eventId'>,
): string {
  return JSON.stringify([
    event.namespace,
    event.origin,
    event.sourceKey,
    event.eventId,
  ]);
}

export interface InboundEventSourceRegistry {
  register(source: InboundEventSource): () => void;
  hasUnsettled(): boolean;
  settleAll(): Promise<void>;
  pauseAll(): void;
}

class InboundEventSourceRegistryModule implements InboundEventSourceRegistry {
  private readonly sources = new Set<InboundEventSource>();
  private paused = false;

  register(source: InboundEventSource): () => void {
    this.sources.add(source);
    // A source registered after pausing must not deliver either.
    if (this.paused) source.pause();
    return () => {
      this.sources.delete(source);
    };
  }

  hasUnsettled(): boolean {
    for (const source of this.sources) {
      if (source.hasUnsettled()) return true;
    }
    return false;
  }

  async settleAll(): Promise<void> {
    // Sources settle independently; one failing must not block the others.
    const results = await Promise.allSettled(
      [...this.sources].map((source) => source.settleDelivered()),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  pauseAll(): void {
    this.paused = true;
    for (const source of this.sources) source.pause();
  }
}

export function createInboundEventSourceRegistry(): InboundEventSourceRegistry {
  return new InboundEventSourceRegistryModule();
}
