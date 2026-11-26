import { randomBytes } from 'node:crypto';

import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { ContextDataUIPart, ContextMetadataValue } from '@/session/inbox';
import type { SessionHistory } from '@/session-history';

import { boundContext, limits } from './bounds';
import { catalog, compile, digest, type Plan, planSchema } from './catalog';
import { type GenerationOptions, generatePlan } from './generator';
import { compatible, page, select } from './projection';

export interface ProjectionResult {
  context: ContextDataUIPart;
  status: 'unchanged' | 'projected' | 'fallback';
  originalBytes: number;
  projectedBytes: number;
}
export interface InputProjections {
  start(): Promise<void>;
  close(): Promise<void>;
  diagnostics(): Record<string, number>;
  prepare(
    sessionId: string,
    messages: readonly ExtendedUIMessage[],
    generation?: GenerationOptions,
  ): Promise<void>;
  present(sessionId: string, context: ContextDataUIPart): ContextDataUIPart;
  readUnfiltered(
    sessionId: string,
    reference: string,
    cursor?: string,
    reason?: string,
  ): Promise<unknown>;
  project(context: ContextDataUIPart, plan?: Plan): ProjectionResult;
}

class InputProjectionsModule implements InputProjections {
  private readonly prepared = new Map<
    string,
    { reference: string; plan?: Plan; revision: string }
  >();
  private readonly occurrences = new WeakMap<
    ContextDataUIPart,
    Map<string, string | null>
  >();
  private readonly flights = new Map<string, Promise<Plan | undefined>>();
  private readonly shutdown = new AbortController();
  private reviewFlight?: Promise<void>;
  private readonly counts = {
    shapeHits: 0,
    shapeMisses: 0,
    generations: 0,
    fallbacks: 0,
    prepared: 0,
    originalBytes: 0,
    projectedBytes: 0,
    detailReads: 0,
    unavailableReads: 0,
    feedbackReviews: 0,
    feedbackUpdates: 0,
  };
  constructor(private readonly history?: SessionHistory) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([
      ...this.flights.values(),
      ...(this.reviewFlight ? [this.reviewFlight] : []),
    ]);
    this.prepared.clear();
  }
  diagnostics(): Record<string, number> {
    return {
      ...this.counts,
      cachedContexts: this.prepared.size,
      activeGenerations: this.flights.size,
    };
  }
  async prepare(
    sessionId: string,
    messages: readonly ExtendedUIMessage[],
    generation?: GenerationOptions,
  ): Promise<void> {
    if (!this.history || this.shutdown.signal.aborted) return;
    await this.history.flush();
    const deadlineAt = Date.now() + limits.preparationMs;
    let generationCount = 0;
    const boundedGeneration = generation
      ? {
          ...generation,
          signal: AbortSignal.any([
            AbortSignal.timeout(limits.preparationMs),
            ...(generation.signal ? [generation.signal] : []),
          ]),
        }
      : undefined;
    if (boundedGeneration && !this.reviewFlight) {
      this.reviewFlight = this.reviewFeedback(boundedGeneration).finally(() => {
        this.reviewFlight = undefined;
      });
    }
    await this.reviewFlight;
    for (const message of messages) {
      for (const [partIndex, part] of message.parts.entries()) {
        if (part.type !== 'data-context') continue;
        const context = structuredClone(part.data);
        const { origin, data, type } = context.metadata;
        if (origin !== 'events' && origin !== 'push-notifications') continue;
        const hash = digest(context);
        const key = JSON.stringify([sessionId, message.id, partIndex, hash]);
        const occurrences =
          this.occurrences.get(part.data) ?? new Map<string, string | null>();
        const previous = occurrences.get(sessionId);
        occurrences.set(
          sessionId,
          previous === undefined || previous === key ? key : null,
        );
        this.occurrences.set(part.data, occurrences);
        try {
          const cached = this.prepared.get(key);
          if (
            cached &&
            (await this.history.readInputProjection(
              sessionId,
              cached.reference,
            ))
          ) {
            // Keep the occurrence pinned, but allow a later awaited boundary to
            // learn a reusable plan after realtime had to use immediate fallback.
            if (
              !generation ||
              (cached.revision !== 'fallback-v1' &&
                cached.plan?.fallbackUntil === undefined)
            )
              continue;
          }
          this.prepared.delete(key);
          if (generation?.signal?.aborted || this.shutdown.signal.aborted)
            return;
          const input = catalog(data === undefined ? {} : data);
          const family = JSON.stringify([2, context.sourceEnv, origin, type]);
          const saved = await this.history.findInputProjectionPlan(
            family,
            input.shape,
          );
          this.counts[saved ? 'shapeHits' : 'shapeMisses']++;
          let plan = saved
            ? planSchema.parse(JSON.parse(saved.body))
            : undefined;
          if (
            (!saved ||
              (plan?.fallbackUntil !== undefined &&
                plan.fallbackUntil <= Date.now())) &&
            generation
          ) {
            const flightKey = digest([family, input.shape]);
            let flight = this.flights.get(flightKey);
            if (
              !flight &&
              this.flights.size < 2 &&
              generationCount < limits.generationsPerPreparation &&
              Date.now() < deadlineAt
            ) {
              generationCount++;
              this.counts.generations++;
              flight = generatePlan(input, {
                ...generation,
                identity: catalog(
                  Object.fromEntries(
                    Object.entries(context.metadata).filter(
                      ([key]) =>
                        key !== 'origin' &&
                        key !== 'data' &&
                        key !== 'eventId' &&
                        !(origin === 'events' && key === '_meta'),
                    ),
                  ),
                ).fields,
                deadlineMs: Math.max(1, deadlineAt - Date.now()),
                signal: AbortSignal.any([
                  this.shutdown.signal,
                  ...(generation.signal ? [generation.signal] : []),
                ]),
              });
              this.flights.set(flightKey, flight);
              void flight.finally(() => this.flights.delete(flightKey));
            }
            plan = await flight;
          }
          if (!plan && data !== undefined) {
            plan = this.fallbackPlan(data);
            if (plan)
              plan.fallbackUntil = Date.now() + (generation ? 60_000 : 0);
          }
          if (
            !saved &&
            plan &&
            plan.fallbackUntil === undefined &&
            plan.fields.every((field) => field.keep)
          ) {
            plan = { ...plan, identity: true };
          }
          let revision = 'fallback-v1';
          if (plan && input.complete) {
            const body = JSON.stringify(plan);
            const stored = await this.history.saveInputProjectionPlan({
              revision: digest([family, input.shape, body]),
              family,
              shape: input.shape,
              body,
            });
            plan = planSchema.parse(JSON.parse(stored.body));
            revision = stored.revision;
          }
          for (let attempt = 0; attempt < 8; attempt++) {
            const binding = await this.history.bindInputProjection({
              reference: randomBytes(6).toString('hex').slice(0, 8),
              sessionId,
              messageId: message.id,
              part: partIndex,
              contextHash: hash,
              revision,
            });
            if (!binding) continue;
            if (this.prepared.size >= 2_048)
              this.prepared.delete(this.prepared.keys().next().value ?? '');
            const pinned = await this.history.readInputProjection(
              sessionId,
              binding.reference,
            );
            if (!pinned) break;
            const pinnedPlan = pinned.plan
              ? planSchema.parse(JSON.parse(pinned.plan.body))
              : pinned.binding.revision === 'identity-v1'
                ? { version: 1 as const, identity: true, fields: [] }
                : undefined;
            if (this.shutdown.signal.aborted) return;
            this.counts.prepared++;
            const result = this.project(context, pinnedPlan);
            this.counts.originalBytes += result.originalBytes;
            this.counts.projectedBytes += result.projectedBytes;
            if (result.status === 'fallback') this.counts.fallbacks++;
            this.prepared.set(key, {
              reference: binding.reference,
              plan: pinnedPlan,
              revision: binding.revision,
            });
            break;
          }
        } catch {
          // Isolate corrupt/stale rows and transient storage failures to this occurrence.
          this.prepared.delete(key);
        }
      }
    }
  }
  private async reviewFeedback(generation: GenerationOptions): Promise<void> {
    if (!this.history) return;
    for (const review of await this.history.pendingInputProjectionReviews()) {
      if (this.shutdown.signal.aborted || generation.signal?.aborted) return;
      if (!review.plan) {
        await this.history.completeInputProjectionReview(review);
        continue;
      }
      const latest = await this.history.findInputProjectionPlan(
        review.plan.family,
        review.plan.shape,
      );
      if (latest?.revision !== review.revision) {
        await this.history.completeInputProjectionReview(review);
        continue;
      }
      const current = planSchema.parse(JSON.parse(review.plan.body));
      const input = {
        fields: current.fields.map(({ path, type }) => ({
          path,
          type,
          sample: '',
        })),
        complete: true,
        shape: review.plan.shape,
      };
      this.counts.feedbackReviews++;
      const revised = await generatePlan(
        input,
        {
          ...generation,
          signal: AbortSignal.any([
            this.shutdown.signal,
            ...(generation.signal ? [generation.signal] : []),
          ]),
        },
        { current, reasons: review.reasons },
      );
      // Failed/timed-out reviews remain queued for a later safe inference boundary.
      if (!revised) {
        await this.history.deferInputProjectionReview(review);
        continue;
      }
      for (const field of revised.fields) {
        if (
          current.fields.some(
            (old) => old.keep && digest(old.path) === digest(field.path),
          )
        )
          field.keep = true;
      }
      const changed = digest(current.fields) !== digest(revised.fields);
      if (changed) this.counts.feedbackUpdates++;
      const body = JSON.stringify(revised);
      await this.history.completeInputProjectionReview(
        review,
        changed
          ? {
              ...review.plan,
              revision: digest([review.plan.family, review.plan.shape, body]),
              body,
            }
          : undefined,
      );
    }
  }
  present(sessionId: string, context: ContextDataUIPart): ContextDataUIPart {
    const key = this.occurrences.get(context)?.get(sessionId);
    const binding = key ? this.prepared.get(key) : undefined;
    // Never hide data until its canonical source and recovery binding are durable.
    if (!binding) return boundContext(context);
    const result = this.project(context, binding.plan);
    return {
      ...result.context,
      metadata: {
        ...result.context.metadata,
        inputEventRef: binding.reference,
      },
    };
  }
  async readUnfiltered(
    sessionId: string,
    reference: string,
    cursor?: string,
    reason?: string,
  ): Promise<unknown> {
    this.counts.detailReads++;
    if (!/^[a-z0-9]{8}$/.test(reference))
      return { status: 'invalid-reference' };
    let stored: Awaited<ReturnType<SessionHistory['readInputProjection']>>;
    try {
      stored = await this.history?.readInputProjection(sessionId, reference);
    } catch {
      return { status: 'unavailable' };
    }
    if (!stored) {
      this.counts.unavailableReads++;
      return { status: 'unavailable' };
    }
    try {
      const result = page(
        stored.context,
        reference,
        stored.binding.revision,
        cursor,
      );
      if (
        !cursor &&
        stored.plan &&
        reason?.trim() &&
        reason.trim().length <= 1_000
      ) {
        // Feedback failure must never hide an otherwise valid detail response.
        await this.history
          ?.recordInputProjectionFetch(stored.binding.revision, reason.trim())
          .catch(() => {});
      }
      return result;
    } catch {
      return { status: 'invalid-cursor' };
    }
  }
  private fallbackPlan(value: ContextMetadataValue): Plan | undefined {
    const input = catalog(value);
    if (!input.complete) return undefined;
    return compile(input, {
      // Conservative fallback: preserve short facts; omit opaque IDs and incidental links.
      keep: input.fields
        .filter(
          ({ path }) =>
            !(
              /(?:trace|tracking|avatar|internal|token|uuid|url|^id$)/i.test(
                path.at(-1) ?? '',
              ) || /(?:trace|tracking|debug|internal)/i.test(path.join('/'))
            ),
        )
        .map(({ path }) => path),
    });
  }
  project(context: ContextDataUIPart, plan?: Plan): ProjectionResult {
    const originalBytes = Buffer.byteLength(JSON.stringify(context.metadata));
    const finish = (
      source: ContextDataUIPart,
      status: ProjectionResult['status'],
    ): ProjectionResult => {
      const bounded = boundContext(source);
      const filtered =
        status !== 'unchanged' || bounded.metadata.inputPreviewLimited === true;
      const metadata = {
        ...bounded.metadata,
        ...(filtered
          ? {
              inputFiltered: true,
              inputFilterNote:
                'Filtered event: keys or full values may be omitted. Use getUnfilteredInput with inputEventRef to retrieve the complete original event.',
            }
          : {}),
      };
      return {
        context: { ...bounded, metadata },
        status,
        originalBytes,
        projectedBytes: Buffer.byteLength(JSON.stringify(metadata)),
      };
    };
    const { origin, data } = context.metadata;
    if (
      (origin !== 'events' && origin !== 'push-notifications') ||
      data === undefined
    )
      return finish(context, 'unchanged');
    if (plan?.identity) return finish(context, 'unchanged');
    const invalid = plan !== undefined && !compatible(plan, data);
    const selected = invalid || !plan ? this.fallbackPlan(data) : plan;
    const payload = selected
      ? (select(selected, data) as ContextMetadataValue)
      : data;
    if (JSON.stringify(payload) === JSON.stringify(data))
      return finish(context, 'unchanged');
    // Every selected field is still bounded, including routing and conversational names.
    const status =
      invalid || !plan || !selected || plan.fallbackUntil !== undefined
        ? 'fallback'
        : 'projected';
    return finish(
      {
        ...context,
        metadata: {
          ...context.metadata,
          data: payload,
          projectionStatus: status,
        },
      },
      status,
    );
  }
}
export function createInputProjections(
  history?: SessionHistory,
): InputProjections {
  return new InputProjectionsModule(history);
}
