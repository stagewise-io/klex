import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const CALLBACK_PATH = '/oauth/callback';
const LOOPBACK_ADDRESS = '127.0.0.1';

interface OAuthCallbackWaitOptions {
  signal?: AbortSignal;
  state: string;
  timeoutMs: number;
}

interface PendingCallback {
  abortCleanup?: () => void;
  options: OAuthCallbackWaitOptions;
  reject: (error: Error) => void;
  resolve: (callback: URLSearchParams) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class OAuthCallbackError extends Error {}

export class LocalOAuthCallbackReceiver {
  private pending?: PendingCallback;

  private constructor(
    private readonly server: Server,
    public readonly redirectUrl: URL,
  ) {}

  public static async start(): Promise<LocalOAuthCallbackReceiver> {
    let receiver: LocalOAuthCallbackReceiver | undefined;
    const server = createServer((request, response) =>
      receiver?.handleRequest(request, response),
    );

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_ADDRESS, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('OAuth callback listener did not bind to a TCP port');
    }

    receiver = new LocalOAuthCallbackReceiver(
      server,
      new URL(`http://${LOOPBACK_ADDRESS}:${address.port}${CALLBACK_PATH}`),
    );
    return receiver;
  }

  public async close(): Promise<void> {
    this.rejectPending(
      new OAuthCallbackError('OAuth callback listener closed'),
    );
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  public waitForCallback(
    options: OAuthCallbackWaitOptions,
  ): Promise<URLSearchParams> {
    if (this.pending) {
      return Promise.reject(
        new OAuthCallbackError('An OAuth callback is already pending'),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new OAuthCallbackError('OAuth authorization was canceled'),
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending;
        this.pending = undefined;
        pending?.abortCleanup?.();
        reject(new OAuthCallbackError('OAuth authorization timed out'));
      }, options.timeoutMs);
      timeout.unref();

      const abort = () =>
        this.rejectPending(
          new OAuthCallbackError('OAuth authorization was canceled'),
        );
      this.pending = {
        abortCleanup: options.signal
          ? () => options.signal?.removeEventListener('abort', abort)
          : undefined,
        options,
        reject,
        resolve,
        timeout,
      };
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const requestUrl = new URL(request.url ?? '/', this.redirectUrl);
    if (request.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH) {
      this.respond(response, 404, 'Not found');
      return;
    }

    const pending = this.pending;
    if (!pending) {
      this.respond(
        response,
        410,
        'This OAuth authorization request is no longer active.',
      );
      return;
    }

    const state = requestUrl.searchParams.get('state');
    if (!state || !secureEqual(state, pending.options.state)) {
      this.respond(
        response,
        400,
        'Invalid OAuth state. Return to Klex and retry authorization.',
      );
      return;
    }

    const error = requestUrl.searchParams.get('error');
    if (error) {
      this.respond(
        response,
        400,
        'OAuth authorization was not completed. You can close this tab.',
      );
      this.rejectPending(
        new OAuthCallbackError('OAuth authorization was denied or failed'),
      );
      return;
    }

    const code = requestUrl.searchParams.get('code');
    if (!code) {
      this.respond(
        response,
        400,
        'The OAuth callback did not include an authorization code.',
      );
      this.rejectPending(
        new OAuthCallbackError(
          'OAuth callback did not include an authorization code',
        ),
      );
      return;
    }

    this.respond(
      response,
      200,
      'Authorization completed. You can close this tab and return to Klex.',
    );
    this.resolvePending(new URLSearchParams(requestUrl.searchParams));
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    pending.abortCleanup?.();
    pending.reject(error);
  }

  private resolvePending(callback: URLSearchParams): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    pending.abortCleanup?.();
    pending.resolve(callback);
  }

  private respond(
    response: ServerResponse,
    status: number,
    message: string,
  ): void {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Content-Type': 'text/plain; charset=utf-8',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(message);
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
