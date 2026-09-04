import type { Span } from '@opentelemetry/api';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelSelectionEntry } from '@/config';

/**
 * Default cooldown duration: the session stays on a fallback model for 5
 * minutes after the last successful generation before reverting to the
 * default model.
 */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Manages model fallback state with a stickiness cooldown.
 *
 * When a model fallback occurs (via {@link fallbackToNextModel}), the manager
 * switches to the next model in the list and starts a cooldown timer. The
 * session stays on the fallback model until the cooldown expires. Each
 * successful generation (via {@link recordSuccessfulGeneration}) refreshes the
 * timer, keeping the session on the fallback as long as it's working. Once the
 * cooldown expires, the next call to {@link getChatModelEntry} resets back to the
 * default model (index 0).
 */
export class ModelFallbackManager {
  private fallbackIndex = 0;
  private fallbackExpiresAt: number | null = null;
  private lastSuccessfulGenerationAt: number | null = null;
  private readonly cooldownMs: number;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      span: Span;
      sessionId: string;
      getChatModels: () => readonly ModelSelectionEntry[];
    },
    cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ) {
    this.cooldownMs = cooldownMs;
  }

  /**
   * Returns the current model selection entry, resetting to the
   * default model if the fallback cooldown has expired.
   */
  getChatModelEntry(): ModelSelectionEntry | undefined {
    const chatModels = this.deps.getChatModels();
    if (chatModels.length === 0) {
      // Reset stale fallback state so models added at runtime start at the
      // configured default rather than an old index.
      this.fallbackIndex = 0;
      this.fallbackExpiresAt = null;
      this.lastSuccessfulGenerationAt = null;
      return undefined;
    }

    // Check if the fallback cooldown has expired. If so, reset to the
    // default model (index 0).
    if (
      this.fallbackIndex > 0 &&
      this.fallbackExpiresAt !== null &&
      Date.now() >= this.fallbackExpiresAt
    ) {
      this.deps.logger.debug(
        {
          sessionId: this.deps.sessionId,
          previousIndex: this.fallbackIndex,
          expiredAt: new Date(this.fallbackExpiresAt).toISOString(),
        },
        'Fallback cooldown expired — resetting to default model',
      );
      this.fallbackIndex = 0;
      this.fallbackExpiresAt = null;
      this.lastSuccessfulGenerationAt = null;
    }

    const index = this.fallbackIndex % chatModels.length;
    const entry = chatModels[index];
    return entry;
  }

  /** Returns the current fallback index (0 = default model). */
  getFallbackIndex(): number {
    return this.fallbackIndex;
  }

  /**
   * Advances to the next model in the list and starts/refreshes the fallback
   * cooldown.
   */
  fallbackToNextModel(): void {
    const chatModels = this.deps.getChatModels();
    if (chatModels.length === 0) {
      this.deps.logger.warn(
        { sessionId: this.deps.sessionId },
        'Cannot fall back because no chat models are configured',
      );
      return;
    }
    this.fallbackIndex = (this.fallbackIndex + 1) % chatModels.length;

    // Start or extend the fallback cooldown. The session stays on the
    // fallback model for cooldownMs after the last successful generation.
    this.fallbackExpiresAt = Date.now() + this.cooldownMs;

    this.deps.span.addEvent('session.model_fallback', {
      'session.modelFallbackIndex': this.fallbackIndex,
      'session.fallbackExpiresAt': new Date(
        this.fallbackExpiresAt,
      ).toISOString(),
    });
  }

  /**
   * Called after a successful generation to refresh the fallback cooldown.
   * If the session is currently on a fallback model, the expiry is pushed
   * forward by cooldownMs from now. If on the default model, this is a no-op.
   */
  recordSuccessfulGeneration(): void {
    if (this.fallbackIndex > 0) {
      this.lastSuccessfulGenerationAt = Date.now();
      this.fallbackExpiresAt =
        this.lastSuccessfulGenerationAt + this.cooldownMs;
    }
  }
}
