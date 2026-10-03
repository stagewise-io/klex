import { randomUUID } from 'node:crypto';

import { SpanStatusCode } from '@opentelemetry/api';

import type { ModuleLogger } from '@stagewise/logger';

import type { InstinctConfig } from '@/config';
import type { ExtensionHandler } from '@/session/chat/extension-handler';
import type {
  InstinctClassificationOutcome,
  InstinctInput,
  InstinctReactionStatus,
  InstinctSummary,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { tracer } from '@/session/chat/utils/tracing';

import {
  classifyInstinct,
  createInstinctClassifierEntries,
  type InstinctClassifier,
  type InstinctClassifierEntry,
  validateInstinctClassificationRequest,
} from './classifier';
import { buildInstinctClassifierInput } from './classifier-input';
import {
  InstinctHistoryDeltaTracker,
  type PendingInstinctDelta,
} from './history-delta';
import { InstinctPreparationBuffer } from './instinct-preparation';

type Parts = ExtendedUIMessage['parts'];

export interface InstinctRunnerDeps {
  readonly logger: ModuleLogger;
  readonly extensionHandler: ExtensionHandler;
  /** Read on every run, so config changes apply to the next step. */
  readonly getConfig: () => InstinctConfig;
  /** Structured-output call over the `instincts` model purpose. */
  readonly execute: InstinctClassifier;
}

export interface InstinctRunOptions {
  /** Canonical history; snapshotted at the start of the run. */
  readonly history: readonly ExtendedUIMessage[];
  /** Step-level cancellation (critical input, lease quiesce, close). */
  readonly signal: AbortSignal;
}

/** A persistent message to append at commit, one per extension. */
export interface PersistentInstinctPreparation {
  readonly extensionIdentifier: string;
  readonly message: ExtendedUIMessage;
}

export type InstinctResult =
  /** Disabled, or no extension participates. Nothing happened. */
  | { readonly status: 'skipped' }
  /** The step signal fired. Nothing is committed; the baseline is kept. */
  | { readonly status: 'aborted'; readonly summary: InstinctSummary }
  | {
      readonly status: 'ready';
      readonly summary: InstinctSummary;
      /** Factory order. Appended to canonical history by {@link commit}. */
      readonly persistent: readonly PersistentInstinctPreparation[];
      /** Prepended to the step's provisional context parts. */
      readonly provisional: Parts;
      /** Injected into the inference clone only. */
      readonly ephemeral: Parts;
      /**
       * Synchronously appends the persistent messages to `messages` and
       * advances the delta baseline. Call exactly once, before model
       * resolution.
       */
      readonly commit: (messages: ExtendedUIMessage[]) => void;
    };

export interface InstinctRunner {
  run(options: InstinctRunOptions): Promise<InstinctResult>;
  /** Last run summary for introspection. */
  readonly lastSummary: InstinctSummary | null;
}

function reactionStatus(
  settled: 'fulfilled' | 'rejected' | 'aborted',
  stepSignal: AbortSignal,
  deadline: AbortSignal,
): InstinctReactionStatus {
  if (settled === 'fulfilled') return 'ok';
  if (settled === 'rejected') return 'failed';
  if (stepSignal.aborted) return 'aborted';
  return deadline.aborted ? 'timeout' : 'aborted';
}

/**
 * Orchestrates one step's instinct: snapshot → classify → react → staged
 * result. Owned by the session (one per session) because the delta
 * baseline spans steps and turns. Never throws for extension or classifier
 * failures; only the step signal can turn a run into `aborted`.
 */
class InstinctRunnerModule implements InstinctRunner {
  private readonly deltaTracker = new InstinctHistoryDeltaTracker();
  private _lastSummary: InstinctSummary | null = null;

  constructor(private readonly deps: InstinctRunnerDeps) {}

  get lastSummary(): InstinctSummary | null {
    return this._lastSummary;
  }

  async run(options: InstinctRunOptions): Promise<InstinctResult> {
    const config = this.deps.getConfig();
    const { extensionHandler } = this.deps;
    if (!config.enabled || !extensionHandler.hasInstinctParticipants()) {
      return { status: 'skipped' };
    }

    return tracer.startActiveSpan('step.instinct', async (span) => {
      try {
        const result = await this.execute(options, config);
        span.setAttribute('instinct.status', result.status);
        if (result.status !== 'skipped') {
          span.setAttribute(
            'instinct.classifierStatus',
            result.summary.classifierStatus,
          );
          span.setAttribute('instinct.durationMs', result.summary.durationMs);
        }
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async execute(
    options: InstinctRunOptions,
    config: InstinctConfig,
  ): Promise<InstinctResult> {
    const { extensionHandler, logger } = this.deps;
    const startedAt = Date.now();
    const deadlineAt = startedAt + config.timeoutMs;
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([options.signal, deadline]);

    const history = structuredClone(options.history) as ExtendedUIMessage[];
    const pending = this.deltaTracker.compute(history);
    const input: InstinctInput = { history, delta: pending.delta };

    const entries = createInstinctClassifierEntries(
      extensionHandler
        .collectInstinctClassificationRequests(input)
        .filter(({ extensionIdentifier, request }) => {
          const reason = validateInstinctClassificationRequest(request);
          if (reason === null) return true;
          logger.warn(
            { extensionIdentifier, reason },
            'Rejected invalid classification request',
          );
          return false;
        }),
    );

    const outcomes = await this.classify(
      entries,
      input,
      options.signal,
      deadline,
      config,
    );
    const classifierStatus = this.classifierStatus(entries, outcomes);

    const buffers = new Map<string, InstinctPreparationBuffer>();
    const settlements = options.signal.aborted
      ? []
      : await extensionHandler.runInstinctReactions(
          (extensionIdentifier) => {
            const prepare = new InstinctPreparationBuffer(
              extensionIdentifier,
              extensionHandler.getOwnedDataPartKeys(extensionIdentifier),
            );
            buffers.set(extensionIdentifier, prepare);
            return {
              ...structuredClone(input),
              classification: outcomes.get(extensionIdentifier) ?? null,
              signal,
              deadline: deadlineAt,
              prepare,
            };
          },
          (extensionIdentifier, status) => {
            const buffer = buffers.get(extensionIdentifier);
            if (status === 'fulfilled' && !options.signal.aborted)
              buffer?.keep();
            else buffer?.drop();
          },
        );

    const aborted = options.signal.aborted;
    const reactions = settlements.map((settlement) => {
      const buffer = buffers.get(settlement.extensionIdentifier);
      const counts = buffer?.counts() ?? {
        persistent: 0,
        provisional: 0,
        ephemeral: 0,
      };
      return {
        extensionIdentifier: settlement.extensionIdentifier,
        status: reactionStatus(settlement.status, options.signal, deadline),
        persistentPartCount: counts.persistent,
        provisionalPartCount: counts.provisional,
        ephemeralPartCount: counts.ephemeral,
      };
    });

    const summary: InstinctSummary = {
      durationMs: Date.now() - startedAt,
      classifierStatus,
      reactions,
    };
    this._lastSummary = summary;

    if (aborted) {
      logger.debug({ summary }, 'Instinct aborted');
      return { status: 'aborted', summary };
    }

    return this.stage(settlements, buffers, pending, summary);
  }

  private async classify(
    entries: readonly InstinctClassifierEntry[],
    input: InstinctInput,
    signal: AbortSignal,
    deadline: AbortSignal,
    config: InstinctConfig,
  ): Promise<Map<string, InstinctClassificationOutcome>> {
    if (entries.length === 0) return new Map();
    return tracer.startActiveSpan(
      'step.instinct.classifier',
      { attributes: { 'instinct.extensionCount': entries.length } },
      async (span) => {
        try {
          const prompt = buildInstinctClassifierInput({
            entries,
            history: input.history,
            delta: input.delta,
            dataPartTransformers:
              this.deps.extensionHandler.getDataPartTransformers(),
            limits: config,
          });
          const outcomes = await classifyInstinct({
            entries,
            prompt,
            execute: this.deps.execute,
            signal,
            deadline,
            timeoutMs: config.classifierTimeoutMs,
          });
          span.setAttribute(
            'instinct.classifier.okCount',
            [...outcomes.values()].filter(({ status }) => status === 'ok')
              .length,
          );
          return outcomes;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          this.deps.logger.warn(
            { error },
            'Instinct classification failed; continuing without answers',
          );
          // Do not classify incomplete input. Reactions can recover from a
          // failed outcome, and optional classification must not stop the bot.
          return new Map(
            entries.map(({ extensionIdentifier }) => [
              extensionIdentifier,
              {
                status: 'failed',
                reason: 'classifier input or inference failed',
              } as InstinctClassificationOutcome,
            ]),
          );
        } finally {
          span.end();
        }
      },
    );
  }

  private classifierStatus(
    entries: readonly InstinctClassifierEntry[],
    outcomes: ReadonlyMap<string, InstinctClassificationOutcome>,
  ): InstinctSummary['classifierStatus'] {
    if (entries.length === 0) return 'skipped';
    const statuses = [...outcomes.values()].map(({ status }) => status);
    // Slices are validated independently; any `ok` slice means the call worked.
    return statuses.includes('ok') ? 'ok' : (statuses[0] ?? 'failed');
  }

  private stage(
    settlements: readonly { extensionIdentifier: string }[],
    buffers: ReadonlyMap<string, InstinctPreparationBuffer>,
    pending: PendingInstinctDelta,
    summary: InstinctSummary,
  ): InstinctResult {
    const persistent: PersistentInstinctPreparation[] = [];
    const provisional: Parts[number][] = [];
    const ephemeral: Parts[number][] = [];

    // Settlements are in factory order, which keeps the persistent prefix
    // deterministic for input caching.
    for (const { extensionIdentifier } of settlements) {
      const operations = buffers.get(extensionIdentifier)?.operations();
      if (!operations) continue;
      const ownedKeys =
        this.deps.extensionHandler.getOwnedDataPartKeys(extensionIdentifier);
      const parts = operations.persistent.filter((part) => {
        const key = part.type.slice('data-'.length);
        if (ownedKeys.has(key)) return true;
        this.deps.logger.warn(
          { extensionIdentifier, partType: part.type },
          'Dropped persistent instinct part without an owned dataPartTransformer',
        );
        return false;
      });
      if (parts.length > 0) {
        persistent.push({
          extensionIdentifier,
          message: { id: randomUUID(), role: 'user', parts },
        });
      }
      provisional.push(...operations.provisional);
      ephemeral.push(...operations.ephemeral);
    }

    let committed = false;
    return {
      status: 'ready',
      summary,
      persistent,
      provisional,
      ephemeral,
      commit: (messages) => {
        if (committed) throw new Error('Instinct result already committed');
        committed = true;
        messages.push(...persistent.map(({ message }) => message));
        this.deltaTracker.accept(pending);
      },
    };
  }
}

export function createInstinctRunner(deps: InstinctRunnerDeps): InstinctRunner {
  return new InstinctRunnerModule(deps);
}
