import {
  hasPerRequestPushNotificationsCapability,
  missingPushNotificationsCapabilityError,
} from '../capabilities.js';
import {
  PUSH_NOTIFICATIONS_EXTENSION_ID,
  PUSH_NOTIFICATIONS_NOTIFICATION_METHOD,
  SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
  SUBSCRIPTIONS_LISTEN_METHOD,
} from '../constants.js';
import {
  PushNotificationNotificationParamsSchema,
  PushNotificationsSubscriptionSchema,
  SubscriptionsListenRequestSchema,
} from '../generated/schema.js';
import type {
  PushNotificationNotificationParams,
  PushNotificationsSubscription,
} from '../spec.types.js';

const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

export type PushNotificationsFetch = (request: Request) => Promise<Response>;

export interface PushNotificationsHttpSubscriptionManager {
  fetch(request: Request): Promise<Response>;
  publish(params: PushNotificationNotificationParams): void;
  close(): void;
  readonly subscriberCount: number;
}

export interface PushNotificationsHttpSubscriptionManagerOptions {
  keepAliveMs?: number;
  maxSubscriptions?: number;
}

interface Subscriber {
  id: string | number;
  subscription: PushNotificationsSubscription;
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

class PushNotificationsHttpSubscriptionManagerModule
  implements PushNotificationsHttpSubscriptionManager
{
  readonly #delegate: PushNotificationsFetch;
  readonly #keepAliveMs: number;
  readonly #maxSubscriptions: number;
  readonly #subscribers = new Set<Subscriber>();
  #closed = false;

  constructor(
    delegate: PushNotificationsFetch,
    options: PushNotificationsHttpSubscriptionManagerOptions,
  ) {
    this.#delegate = delegate;
    this.#keepAliveMs = options.keepAliveMs ?? 15_000;
    this.#maxSubscriptions = options.maxSubscriptions ?? 128;
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
      !this.#hasPushNotificationsFilter(body)
    ) {
      return this.#delegate(request);
    }

    return this.#listen(body, request.signal);
  }

  publish(input: PushNotificationNotificationParams): void {
    const params = PushNotificationNotificationParamsSchema.parse(input);
    for (const subscriber of this.#subscribers) {
      subscriber.write({
        jsonrpc: '2.0',
        method: PUSH_NOTIFICATIONS_NOTIFICATION_METHOD,
        params: {
          ...params,
          _meta: {
            ...params._meta,
            [SUBSCRIPTION_ID_META_KEY]: subscriber.id,
          },
        },
      });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) subscriber.close(true);
  }

  #listen(body: unknown, signal: AbortSignal): Response {
    if (this.#closed) {
      return jsonRpcError(null, -32_603, 'Subscription manager is closed');
    }

    const request = SubscriptionsListenRequestSchema.safeParse(body);
    if (!request.success) {
      const id = this.#requestId(body);
      return jsonRpcError(
        id,
        -32_602,
        'Invalid Push Notifications subscription',
      );
    }

    const id = this.#requestId(body);
    const subscriptionValue =
      request.data.params.notifications[PUSH_NOTIFICATIONS_EXTENSION_ID];
    const subscription =
      PushNotificationsSubscriptionSchema.safeParse(subscriptionValue);
    if (!subscription.success) {
      return jsonRpcError(
        id,
        -32_602,
        'Invalid Push Notifications subscription',
      );
    }

    const metadata = request.data.params._meta;
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      !hasPerRequestPushNotificationsCapability(
        metadata as Record<string, unknown>,
      )
    ) {
      const error = missingPushNotificationsCapabilityError();
      return jsonRpcError(id, error.code, error.message, error.data);
    }

    if (this.#subscribers.size >= this.#maxSubscriptions) {
      return jsonRpcError(id, -32_603, 'Subscription limit reached');
    }

    if (id === null) {
      return jsonRpcError(
        null,
        -32_602,
        'Invalid Push Notifications subscription',
      );
    }

    return this.#createStream(
      id,
      subscription.data,
      signal,
      typeof metadata === 'object' && metadata !== null
        ? (metadata as { progressToken?: string | number }).progressToken
        : undefined,
    );
  }

  #createStream(
    id: string | number,
    subscription: PushNotificationsSubscription,
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
          this.#subscribers.delete(subscriber);
          try {
            controller.close();
          } catch {}
        };

        subscriber = { id, subscription, write, close };
        this.#subscribers.add(subscriber);
        write({
          jsonrpc: '2.0',
          method: SUBSCRIPTIONS_ACKNOWLEDGED_METHOD,
          params: {
            notifications: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: subscription },
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

  #hasPushNotificationsFilter(body: object): boolean {
    if (!('params' in body) || typeof body.params !== 'object') return false;
    if (body.params === null || !('notifications' in body.params)) return false;
    const notifications = body.params.notifications;
    return (
      typeof notifications === 'object' &&
      notifications !== null &&
      Object.hasOwn(notifications, PUSH_NOTIFICATIONS_EXTENSION_ID)
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

export function createPushNotificationsHttpSubscriptionManager(
  delegate: PushNotificationsFetch,
  options: PushNotificationsHttpSubscriptionManagerOptions = {},
): PushNotificationsHttpSubscriptionManager {
  return new PushNotificationsHttpSubscriptionManagerModule(delegate, options);
}
