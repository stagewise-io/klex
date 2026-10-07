import { decodeJwt } from 'jose';

import type { MachineCatalog } from './catalog.js';

export interface MachineCatalogPublisherOptions {
  /** `{cloud}/api/machines/{id}/lifecycle/report`. */
  reportUrl: string;
  /** Token with `machine:lifecycle-report` scope. */
  getToken(): Promise<string>;
  invalidateToken(): void;
  buildCatalog(): Promise<MachineCatalog>;
  fetch?: typeof globalThis.fetch;
  onError?(error: unknown): void;
  maxAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

export interface MachineCatalogPublisher {
  /** Publish (again). Concurrent calls coalesce into one follow-up run. */
  publish(): Promise<PublishOutcome>;
  close(): void;
}

export type PublishOutcome =
  | 'published'
  | 'skipped-no-generation'
  | 'rejected'
  | 'exhausted'
  | 'closed';

class PermanentPublishError extends Error {}

/**
 * Pushes the daemon catalog to Cloud so agents can read it while the machine
 * is paused. Generation comes from the signed token so Cloud can fence it.
 */
export function createMachineCatalogPublisher(
  options: MachineCatalogPublisherOptions,
): MachineCatalogPublisher {
  const fetch = options.fetch ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 6;
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maximumDelayMs = options.maximumDelayMs ?? 30_000;
  const controller = new AbortController();
  let catalog: Promise<MachineCatalog> | undefined;
  let running: Promise<PublishOutcome> | undefined;
  let queued: Promise<PublishOutcome> | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        controller.signal.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      }
      controller.signal.addEventListener('abort', done, { once: true });
    });

  const attempt = async (): Promise<PublishOutcome> => {
    const token = await options.getToken();
    const generation = decodeJwt(token).machine_generation;
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      return 'skipped-no-generation';
    catalog ??= options.buildCatalog().catch((error: unknown) => {
      catalog = undefined;
      throw error;
    });
    const response = await fetch(options.reportUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ generation, catalog: await catalog }),
      signal: controller.signal,
    });
    await response.body?.cancel();
    if (response.ok) return 'published';
    // Auth or generation changed: a fresh token carries the current claims.
    if (response.status === 401 || response.status === 409) {
      options.invalidateToken();
      throw new Error(`Catalog report returned ${response.status}`);
    }
    if (response.status >= 500 || response.status === 429)
      throw new Error(`Catalog report returned ${response.status}`);
    throw new PermanentPublishError(
      `Catalog report rejected with ${response.status}`,
    );
  };

  const run = async (): Promise<PublishOutcome> => {
    let delay = initialDelayMs;
    for (let index = 0; index < maxAttempts; index++) {
      if (controller.signal.aborted) return 'closed';
      try {
        return await attempt();
      } catch (error) {
        if (controller.signal.aborted) return 'closed';
        options.onError?.(error);
        if (error instanceof PermanentPublishError) return 'rejected';
      }
      await sleep(delay * (0.8 + Math.random() * 0.4));
      delay = Math.min(delay * 2, maximumDelayMs);
    }
    return 'exhausted';
  };

  const publish = (): Promise<PublishOutcome> => {
    if (controller.signal.aborted) return Promise.resolve('closed');
    if (!running) {
      running = run().finally(() => {
        running = undefined;
      });
      return running;
    }
    // A reconnect during a run must publish again afterwards.
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return publish();
      });
    return queued;
  };

  return {
    publish,
    close() {
      controller.abort();
    },
  };
}
