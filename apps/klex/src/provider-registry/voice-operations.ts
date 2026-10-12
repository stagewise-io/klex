import type {
  ProviderOperationResult,
  ProviderVoiceList,
  ProviderVoicePreview,
} from './provider-registry';
import { VOICE_PREVIEW_VERSION } from './providers/voice-preview-context';

interface Owned {
  id: string;
  signature: string;
  dependencies?: readonly { id: string; signature: string }[];
}
interface Cached<T> extends Owned {
  expires: number;
  value: T;
}
interface Pending<T> extends Owned {
  controller: AbortController;
  promise: Promise<ProviderOperationResult<T>>;
  waiters: number;
}
const failure = (
  code: 'discovery_failed' | 'preview_failed' | 'rate_limited',
  message: string,
) => ({ ok: false as const, code, message });
const success = <T>(value: T): ProviderOperationResult<T> => ({
  ok: true,
  code: 'available',
  value,
});

/** Registry-owned ephemeral work; does not read or write persistent data. */
class VoiceOperations {
  private readonly lists = new Map<string, Cached<ProviderVoiceList>>();
  private readonly previews = new Map<string, Cached<ProviderVoicePreview>>();
  private readonly pendingLists = new Map<string, Pending<ProviderVoiceList>>();
  private readonly pendingPreviews = new Map<
    string,
    Pending<ProviderVoicePreview>
  >();
  private readonly starts = new Map<
    string,
    { signature: string; times: number[] }
  >();
  private active = 0;
  private activeLists = 0;

  invalidate(valid: (id: string, signature: string) => boolean): void {
    const isValid = (entry: Owned) =>
      valid(entry.id, entry.signature) &&
      (entry.dependencies ?? []).every((dependency) =>
        valid(dependency.id, dependency.signature),
      );
    for (const cache of [this.lists, this.previews]) {
      for (const [key, entry] of cache) if (!isValid(entry)) cache.delete(key);
    }
    for (const pending of [this.pendingLists, this.pendingPreviews]) {
      for (const [key, entry] of pending)
        if (!isValid(entry)) {
          entry.controller.abort();
          pending.delete(key);
        }
    }
    for (const [id, entry] of this.starts) {
      if (!valid(id, entry.signature)) this.starts.delete(id);
    }
  }

  close(): void {
    this.invalidate(() => false);
    this.starts.clear();
  }

  async list(
    id: string,
    signature: string,
    modelId: string,
    refresh: boolean,
    hook: (
      signal: AbortSignal,
    ) => Promise<ProviderOperationResult<ProviderVoiceList>>,
    signal?: AbortSignal,
  ): Promise<ProviderOperationResult<ProviderVoiceList>> {
    const key = JSON.stringify([id, signature, modelId]);
    const cached = this.lists.get(key);
    if (!refresh && cached && cached.expires > Date.now() && !signal?.aborted)
      return success(structuredClone(cached.value));
    if (
      !this.pendingLists.has(key) &&
      !signal?.aborted &&
      (this.pendingLists.size >= 4 || this.activeLists >= 4)
    )
      return failure(
        'rate_limited',
        'Voice discovery limit reached; retry later',
      );
    const result = await this.work(
      key,
      { id, signature },
      this.pendingLists,
      async (abort) => {
        this.activeLists++;
        try {
          return await hook(abort);
        } finally {
          this.activeLists--;
        }
      },
      10_000,
      signal,
      (value) => {
        this.lists.delete(key);
        this.lists.set(key, {
          id,
          signature,
          value: structuredClone(value),
          expires: Date.now() + 300_000,
        });
        while (this.lists.size > 256)
          this.lists.delete(this.lists.keys().next().value!);
      },
      'discovery_failed',
    );
    if (
      !result.ok &&
      !signal?.aborted &&
      result.code === 'discovery_failed' &&
      cached &&
      this.lists.get(key) === cached
    )
      return success({ ...structuredClone(cached.value), stale: true });
    return result.ok ? success(structuredClone(result.value)) : result;
  }

  async preview(
    id: string,
    signature: string,
    modelId: string,
    voiceId: string,
    hook: (
      signal: AbortSignal,
    ) => Promise<ProviderOperationResult<ProviderVoicePreview>>,
    signal?: AbortSignal,
    contextSignature = '',
    dependencies: Owned['dependencies'] = [],
  ): Promise<ProviderOperationResult<ProviderVoicePreview>> {
    const key = JSON.stringify([
      id,
      signature,
      modelId,
      voiceId,
      VOICE_PREVIEW_VERSION,
      contextSignature,
    ]);
    const cached = this.previews.get(key);
    if (cached && cached.expires > Date.now() && !signal?.aborted)
      return success(structuredClone(cached.value));
    if (!this.pendingPreviews.has(key) && !signal?.aborted) {
      const now = Date.now();
      const starts = (this.starts.get(id)?.times ?? []).filter(
        (time) => now - time < 60_000,
      );
      if (
        this.active >= 2 ||
        this.pendingPreviews.size >= 2 ||
        starts.length >= 10
      )
        return failure(
          'rate_limited',
          'Voice preview generation limit reached; retry later',
        );
      this.starts.set(id, { signature, times: [...starts, now] });
    }
    const result = await this.work(
      key,
      { id, signature, dependencies },
      this.pendingPreviews,
      async (abort) => {
        this.active++;
        try {
          const result = await hook(abort);
          if (
            result.ok &&
            (result.value.audio.byteLength < 44 ||
              result.value.audio.byteLength > 1_048_576)
          )
            return failure('preview_failed', 'Invalid preview audio');
          return result;
        } finally {
          this.active--;
        }
      },
      30_000,
      signal,
      (value) => {
        if (value.audio.byteLength === 0 || value.audio.byteLength > 1_048_576)
          return;
        this.previews.delete(key);
        this.previews.set(key, {
          id,
          signature,
          dependencies,
          value: structuredClone(value),
          expires: Date.now() + 86_400_000,
        });
        let bytes = [...this.previews.values()].reduce(
          (sum, item) => sum + item.value.audio.byteLength,
          0,
        );
        while (this.previews.size > 64 || bytes > 16 * 1024 * 1024) {
          const oldest = this.previews.keys().next().value!;
          bytes -= this.previews.get(oldest)!.value.audio.byteLength;
          this.previews.delete(oldest);
        }
      },
      'preview_failed',
    );
    return result.ok ? success(structuredClone(result.value)) : result;
  }

  private work<T>(
    key: string,
    owner: Owned,
    pending: Map<string, Pending<T>>,
    hook: (signal: AbortSignal) => Promise<ProviderOperationResult<T>>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    cache: (value: T) => void,
    code: 'discovery_failed' | 'preview_failed',
  ): Promise<ProviderOperationResult<T>> {
    if (signal?.aborted)
      return Promise.resolve(failure(code, 'Voice operation cancelled'));
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const operation: Pending<T> = {
        ...owner,
        controller,
        waiters: 0,
        promise: Promise.resolve(failure(code, 'Voice operation failed')),
      };
      pending.set(key, operation);
      operation.promise = (async () => {
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<ProviderOperationResult<T>>((resolve) => {
          abortListener = () =>
            resolve(failure(code, 'Voice operation cancelled or timed out'));
          controller.signal.addEventListener('abort', abortListener, {
            once: true,
          });
        });
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        timeout.unref?.();
        try {
          const result = await Promise.race([
            Promise.resolve()
              .then(() =>
                controller.signal.aborted
                  ? failure(code, 'Voice operation cancelled')
                  : hook(controller.signal),
              )
              .catch(() => failure(code, 'Voice provider request failed')),
            aborted,
          ]);
          if (controller.signal.aborted || pending.get(key) !== operation)
            return failure(code, 'Voice operation cancelled');
          if (result.ok) cache(result.value);
          return result;
        } finally {
          clearTimeout(timeout);
          if (abortListener)
            controller.signal.removeEventListener('abort', abortListener);
          if (pending.get(key) === operation) pending.delete(key);
        }
      })();
      entry = operation;
    }
    const shared = entry;
    shared.waiters++;
    return new Promise((resolve) => {
      let done = false;
      const settle = (result: ProviderOperationResult<T>) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', cancel);
        shared.waiters--;
        if (shared.waiters === 0 && pending.get(key) === shared) {
          shared.controller.abort();
          pending.delete(key);
        }
        resolve(result);
      };
      const cancel = () => settle(failure(code, 'Voice operation cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      void shared.promise.then((result) =>
        settle(
          shared.controller.signal.aborted
            ? failure(code, 'Voice operation cancelled')
            : result,
        ),
      );
    });
  }
}

export function createVoiceOperations() {
  return new VoiceOperations();
}
