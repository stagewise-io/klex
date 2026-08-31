import type { LocalOAuthCallbackReceiver } from './local-callback';

const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;

export type PresentAuthorization = (authorizationUrl: URL) => Promise<void>;

export class LocalOAuthAuthorizationCoordinator {
  private readonly controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly present: PresentAuthorization) {}

  public authorize(options: {
    authorizationUrl: URL;
    receiver: LocalOAuthCallbackReceiver;
    signal: AbortSignal;
    state: string;
  }): Promise<URLSearchParams> {
    const result = this.queue.then(async () => {
      if (this.controller.signal.aborted || options.signal.aborted) {
        throw new Error('OAuth authorization was canceled');
      }
      const signal = AbortSignal.any([this.controller.signal, options.signal]);
      const callback = options.receiver.waitForCallback({
        signal,
        state: options.state,
        timeoutMs: AUTHORIZATION_TIMEOUT_MS,
      });
      await this.present(options.authorizationUrl);
      return callback;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public async close(): Promise<void> {
    this.controller.abort(new Error('OAuth authorization coordinator closed'));
    await this.queue;
  }
}
