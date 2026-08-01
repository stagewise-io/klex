import {
  hasPerRequestRealtimeMediaCapability,
  missingRealtimeMediaCapabilityError,
} from '../capabilities.js';
import {
  REALTIME_MEDIA_EXTENSION_ID,
  REALTIME_MEDIA_SESSION_ENDED_METHOD,
  REALTIME_MEDIA_SESSION_OFFERED_METHOD,
  SUBSCRIPTION_ID_META_KEY,
  SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
  SUBSCRIPTIONS_LISTEN_METHOD,
} from '../constants.js';
import {
  RealtimeMediaSessionEndedNotificationParamsSchema,
  RealtimeMediaSessionOfferedNotificationParamsSchema,
  RealtimeMediaSubscriptionSchema,
  SubscriptionsListenRequestSchema,
} from '../generated/schema.js';
import type {
  RealtimeMediaSessionEndedNotificationParams,
  RealtimeMediaSessionOfferedNotificationParams,
  RealtimeMediaSubscription,
} from '../spec.types.js';

export type RealtimeMediaFetch = (request: Request) => Promise<Response>;

export interface RealtimeMediaHttpSubscriptionManager {
  fetch(request: Request): Promise<Response>;
  publishSessionOffered(
    consumerKey: string,
    params: RealtimeMediaSessionOfferedNotificationParams,
  ): void;
  publishSessionEnded(
    consumerKey: string,
    params: RealtimeMediaSessionEndedNotificationParams,
  ): void;
  close(): void;
  readonly subscriberCount: number;
}

export interface RealtimeMediaHttpSubscriptionManagerOptions {
  resolveConsumerKey(request: Request): string | Promise<string>;
  keepAliveMs?: number;
  maxSubscriptions?: number;
  onSubscriptionStateChanged?: (consumerKey: string, active: boolean) => void;
}

interface Subscriber {
  id: string | number;
  consumerKey: string;
  subscription: RealtimeMediaSubscription;
  write(message: unknown): void;
  close(graceful: boolean): void;
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    { status: 200 },
  );
}

class RealtimeMediaHttpSubscriptionManagerModule
  implements RealtimeMediaHttpSubscriptionManager
{
  readonly #delegate: RealtimeMediaFetch;
  readonly #keepAliveMs: number;
  readonly #maxSubscriptions: number;
  readonly #resolveConsumerKey: (request: Request) => string | Promise<string>;
  readonly #onSubscriptionStateChanged?: (
    consumerKey: string,
    active: boolean,
  ) => void;
  readonly #subscribers = new Map<string, Subscriber>();
  #closed = false;

  constructor(
    delegate: RealtimeMediaFetch,
    options: RealtimeMediaHttpSubscriptionManagerOptions,
  ) {
    this.#delegate = delegate;
    this.#keepAliveMs = options.keepAliveMs ?? 15_000;
    this.#maxSubscriptions = options.maxSubscriptions ?? 128;
    this.#resolveConsumerKey = options.resolveConsumerKey;
    this.#onSubscriptionStateChanged = options.onSubscriptionStateChanged;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return this.#delegate(request);

    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return this.#delegate(request);
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      !('method' in body) ||
      body.method !== SUBSCRIPTIONS_LISTEN_METHOD ||
      !this.#hasRealtimeMediaFilter(body)
    ) {
      return this.#delegate(request);
    }

    return this.#listen(body, request);
  }

  publishSessionOffered(
    consumerKey: string,
    input: RealtimeMediaSessionOfferedNotificationParams,
  ): void {
    this.#publish(
      consumerKey,
      REALTIME_MEDIA_SESSION_OFFERED_METHOD,
      RealtimeMediaSessionOfferedNotificationParamsSchema.parse(input),
    );
  }

  publishSessionEnded(
    consumerKey: string,
    input: RealtimeMediaSessionEndedNotificationParams,
  ): void {
    this.#publish(
      consumerKey,
      REALTIME_MEDIA_SESSION_ENDED_METHOD,
      RealtimeMediaSessionEndedNotificationParamsSchema.parse(input),
    );
  }

  #publish(
    consumerKey: string,
    method: string,
    params: { _meta?: Record<string, unknown> },
  ): void {
    const subscriber = this.#subscribers.get(consumerKey);
    if (!subscriber) return;
    subscriber.write({
      jsonrpc: '2.0',
      method,
      params: {
        ...params,
        _meta: {
          ...params._meta,
          [SUBSCRIPTION_ID_META_KEY]: subscriber.id,
        },
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of [...this.#subscribers.values()]) {
      subscriber.close(true);
    }
  }

  async #listen(body: unknown, request: Request): Promise<Response> {
    if (this.#closed) {
      return jsonRpcError(null, -32_603, 'Subscription manager is closed');
    }

    const parsedRequest = SubscriptionsListenRequestSchema.safeParse(body);
    if (!parsedRequest.success) {
      const id = this.#requestId(body);
      return jsonRpcError(
        id,
        -32_602,
        'Invalid Push Notifications subscription',
      );
    }

    const id = this.#requestId(body);
    const subscriptionValue =
      parsedRequest.data.params.notifications[REALTIME_MEDIA_EXTENSION_ID];
    const subscription =
      RealtimeMediaSubscriptionSchema.safeParse(subscriptionValue);
    if (!subscription.success) {
      return jsonRpcError(
        id,
        -32_602,
        'Invalid Push Notifications subscription',
      );
    }

    const metadata = parsedRequest.data.params._meta;
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      !hasPerRequestRealtimeMediaCapability(metadata as Record<string, unknown>)
    ) {
      const error = missingRealtimeMediaCapabilityError();
      return jsonRpcError(id, error.code, error.message, error.data);
    }

    if (id === null) {
      return jsonRpcError(
        null,
        -32_602,
        'Invalid Push Notifications subscription',
      );
    }

    let consumerKey: string;
    try {
      consumerKey = await this.#resolveConsumerKey(request);
      if (consumerKey.length === 0) throw new Error('Empty consumer key');
    } catch {
      return jsonRpcError(id, -32_001, 'Unable to resolve consumer identity');
    }

    if (
      !this.#subscribers.has(consumerKey) &&
      this.#subscribers.size >= this.#maxSubscriptions
    ) {
      return jsonRpcError(id, -32_603, 'Subscription limit reached');
    }

    return this.#createStream(
      id,
      consumerKey,
      subscription.data,
      request.signal,
      typeof metadata === 'object' && metadata !== null
        ? (metadata as { progressToken?: string | number }).progressToken
        : undefined,
    );
  }

  #createStream(
    id: string | number,
    consumerKey: string,
    subscription: RealtimeMediaSubscription,
    signal: AbortSignal,
    progressToken?: string | number,
  ): Response {
    const encoder = new TextEncoder();
    let subscriber: Subscriber;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    let removeAbort: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let ended = false;
        const writeFrame = (frame: string): void => {
          if (ended) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            subscriber.close(false);
          }
        };
        const write = (message: unknown): void => {
          writeFrame(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        };
        const close = (graceful: boolean): void => {
          if (ended) return;
          if (graceful) {
            write({
              jsonrpc: '2.0',
              id,
              result: {
                resultType: 'complete',
                _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
              },
            });
          }
          ended = true;
          if (keepAlive !== undefined) clearInterval(keepAlive);
          removeAbort?.();
          if (this.#subscribers.get(consumerKey) === subscriber) {
            this.#subscribers.delete(consumerKey);
            this.#notifySubscriptionState(consumerKey, false);
          }
          try {
            controller.close();
          } catch {}
        };

        subscriber = { id, consumerKey, subscription, write, close };
        this.#subscribers.get(consumerKey)?.close(true);
        this.#subscribers.set(consumerKey, subscriber);
        this.#notifySubscriptionState(consumerKey, true);
        write({
          jsonrpc: '2.0',
          method: SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
          params: {
            notifications: { [REALTIME_MEDIA_EXTENSION_ID]: subscription },
            _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
          },
        });

        if (this.#keepAliveMs > 0) {
          keepAlive = setInterval(() => {
            if (progressToken === undefined) {
              writeFrame(': keepalive\n\n');
              return;
            }
            write({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progressToken, progress: Date.now() },
            });
          }, this.#keepAliveMs);
          keepAlive.unref?.();
        }

        const onAbort = (): void => close(false);
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) close(false);
      },
      cancel: () => subscriber.close(false),
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  #notifySubscriptionState(consumerKey: string, active: boolean): void {
    try {
      this.#onSubscriptionStateChanged?.(consumerKey, active);
    } catch {}
  }

  #hasRealtimeMediaFilter(body: object): boolean {
    if (!('params' in body) || typeof body.params !== 'object') return false;
    if (body.params === null || !('notifications' in body.params)) return false;
    const notifications = body.params.notifications;
    return (
      typeof notifications === 'object' &&
      notifications !== null &&
      Object.hasOwn(notifications, REALTIME_MEDIA_EXTENSION_ID)
    );
  }

  #requestId(body: unknown): string | number | null {
    if (typeof body !== 'object' || body === null || !('id' in body)) {
      return null;
    }
    return typeof body.id === 'string' || typeof body.id === 'number'
      ? body.id
      : null;
  }
}

export function createRealtimeMediaHttpSubscriptionManager(
  delegate: RealtimeMediaFetch,
  options: RealtimeMediaHttpSubscriptionManagerOptions,
): RealtimeMediaHttpSubscriptionManager {
  return new RealtimeMediaHttpSubscriptionManagerModule(delegate, options);
}
