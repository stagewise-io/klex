import { randomBytes } from 'node:crypto';

import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { ContextDataUIPart, ContextMetadataValue } from '@/session/inbox';
import type { SessionHistory } from '@/session-history';

import { boundContext, limits, preview } from './bounds';
import {
  catalog,
  compile,
  digest,
  isComplex,
  type Plan,
  planSchema,
  sections,
} from './catalog';
import { type GenerationOptions, generatePlan } from './generator';
import { compatible, page, select } from './projection';

export {
  assignmentSchema,
  catalog,
  compile,
  type Plan,
  planSchema,
} from './catalog';
export { page } from './projection';

export const sectionDescriptions = {
  routing: 'Reply and action routing context',
  objectIds: 'Object and internal identifiers',
  links: 'Additional links',
  other: 'Additional structured fields',
  raw: 'Original metadata as lossless JSON text chunks',
  content: 'Original ordered MCP content blocks',
} as const;
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
  readSection(
    sessionId: string,
    reference: string,
    section: string,
    cursor?: string,
    reason?: string,
  ): Promise<unknown>;
  project(context: ContextDataUIPart, plan?: Plan): ProjectionResult;
  fallbackPlan(value: ContextMetadataValue): Plan | undefined;
}

class InputProjectionsModule implements InputProjections {
  private readonly prepared = new Map<
    string,
    { reference: string; plan?: Plan; revision: string }
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
    if (generation && !this.reviewFlight) {
      this.reviewFlight = this.reviewFeedback(
        boundedGeneration ?? generation,
      ).finally(() => {
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
        const key = `${sessionId}:${hash}`;
        const cached = this.prepared.get(key);
        if (
          cached &&
          (await this.history.readInputProjection(sessionId, cached.reference))
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
        if (generation?.signal?.aborted || this.shutdown.signal.aborted) return;
        const input = catalog(data === undefined ? {} : data);
        const family = JSON.stringify([2, context.sourceEnv, origin, type]);
        const saved = await this.history.findInputProjectionPlan(
          family,
          input.shape,
        );
        this.counts[saved ? 'shapeHits' : 'shapeMisses']++;
        let plan = saved ? planSchema.parse(JSON.parse(saved.body)) : undefined;
        if (
          (!saved ||
            (plan?.fallbackUntil !== undefined &&
              plan.fallbackUntil <= Date.now())) &&
          isComplex(input) &&
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
              ...boundedGeneration,
              generate: generation.generate,
              modelIds: generation.modelIds,
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
          if (plan) plan.fallbackUntil = Date.now() + (generation ? 60_000 : 0);
        }
        if (
          !saved &&
          plan &&
          plan.fallbackUntil === undefined &&
          input.bytes > 0 &&
          Buffer.byteLength(JSON.stringify(select(plan, data, 'default'))) /
            input.bytes >
            0.8
        ) {
          plan = {
            ...compile(input, {
              assignments: input.fields.map(({ fieldId }) => ({
                fieldId,
                section: 'default',
              })),
            }),
            identity: true,
          };
        }
        const smallUnseen = !saved && !isComplex(input);
        if (smallUnseen) plan = undefined;
        let revision = smallUnseen ? 'identity-v1' : 'fallback-v1';
        // Small first occurrences must not suppress learning when later values grow.
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
        fields: current.fields.map((field, index) => ({
          ...field,
          fieldId: `f${index}`,
          sample: '',
        })),
        complete: true,
        shape: review.plan.shape,
        bytes: 0,
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
        { current, section: review.section, reasons: review.reasons },
      );
      // Failed/timed-out reviews remain queued for a later safe inference boundary.
      if (!revised) {
        await this.history.deferInputProjectionReview(review);
        continue;
      }
      for (const field of revised.fields) {
        if (
          current.fields.some(
            (old) =>
              old.section === 'default' &&
              digest(old.path) === digest(field.path),
          )
        )
          field.section = 'default';
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
    const binding = this.prepared.get(`${sessionId}:${digest(context)}`);
    // Never hide data until its canonical source and recovery binding are durable.
    if (!binding) return boundContext(context);
    const result = this.project(context, binding.plan);
    return {
      ...boundContext(result.context),
      metadata: {
        ...boundContext(result.context).metadata,
        inputEventRef: binding.reference,
        moreInfoSections:
          result.status === 'unchanged'
            ? ['raw', 'content']
            : [
                ...sections.filter(
                  (section) =>
                    section !== 'default' &&
                    binding.plan?.fields.some(
                      (field) => field.section === section,
                    ),
                ),
                'raw',
                'content',
              ],
      },
    };
  }
  async readSection(
    sessionId: string,
    reference: string,
    section: string,
    cursor?: string,
    reason?: string,
  ): Promise<unknown> {
    this.counts.detailReads++;
    if (!/^[a-z0-9]{8}$/.test(reference))
      return { status: 'invalid-reference' };
    if (!Object.hasOwn(sectionDescriptions, section))
      return { status: 'unknown-section' };
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
    let plan: Plan | undefined;
    try {
      plan = stored.plan
        ? planSchema.parse(JSON.parse(stored.plan.body))
        : undefined;
    } catch {
      // Original metadata remains recoverable even if a future plan language
      // cannot be executed by this binary.
      if (section !== 'raw') return { status: 'unavailable' };
    }
    if (
      section !== 'raw' &&
      section !== 'content' &&
      plan &&
      !plan.fields.some((field) => field.section === section)
    )
      return { status: 'unknown-section' };
    if (
      section !== 'raw' &&
      section !== 'content' &&
      !plan &&
      (section !== 'other' || stored.binding.revision === 'identity-v1')
    )
      return { status: 'unknown-section' };
    const value =
      section === 'content'
        ? stored.context.content
        : section === 'raw'
          ? stored.context.metadata
          : plan
            ? select(plan, stored.context.metadata.data, section as 'other')
            : stored.context.metadata.data;
    try {
      const result = page(
        value,
        reference,
        section,
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
          ?.recordInputProjectionFetch(
            stored.binding.revision,
            section,
            reason.trim(),
          )
          .catch(() => {});
      }
      return result;
    } catch {
      return { status: 'invalid-cursor' };
    }
  }
  fallbackPlan(value: ContextMetadataValue): Plan | undefined {
    const input = catalog(value);
    if (!input.complete) return undefined;
    return compile(input, {
      assignments: input.fields.map((field) => ({
        fieldId: field.fieldId,
        // Conservative fallback: preserve short facts; omit opaque IDs and incidental links.
        section:
          /(?:trace|tracking|avatar|internal|token|uuid|url|^id$)/i.test(
            field.path.at(-1) ?? '',
          ) || /(?:trace|tracking|debug|internal)/i.test(field.path.join('/'))
            ? 'other'
            : 'default',
      })),
    });
  }
  project(context: ContextDataUIPart, plan?: Plan): ProjectionResult {
    const originalBytes = Buffer.byteLength(JSON.stringify(context.metadata));
    const unchanged: ProjectionResult = {
      context: boundContext(context),
      status: 'unchanged',
      originalBytes,
      projectedBytes: Buffer.byteLength(
        JSON.stringify(boundContext(context).metadata),
      ),
    };
    const { origin, data } = context.metadata;
    if (
      (origin !== 'events' && origin !== 'push-notifications') ||
      data === undefined
    )
      return unchanged;
    if (plan?.identity) return unchanged;
    const input = catalog(data);
    const invalid = plan !== undefined && !compatible(plan, data);
    if (!plan && !isComplex(input)) return unchanged;
    const selected = invalid || !plan ? this.fallbackPlan(data) : plan;
    // A filter without durable retrieval is not allowed to hide information.
    // Preparation supplies references later; this pure layer reports omission explicitly.
    const payload = selected
      ? (select(selected, data, 'default') as ContextMetadataValue)
      : preview(data);
    // Every selected field is still bounded, including routing and conversational names.
    const detailSections = selected
      ? sections.filter(
          (section) =>
            section !== 'default' &&
            selected.fields.some((field) => field.section === section),
        )
      : ['other'];
    const status =
      invalid || !plan || !selected || plan.fallbackUntil !== undefined
        ? 'fallback'
        : 'projected';
    const metadata = {
      ...context.metadata,
      data: preview(payload) as ContextMetadataValue,
      projectionStatus: status,
      moreInfoSections: [...detailSections, 'raw'],
    };
    const bounded = boundContext({ ...context, metadata });
    return {
      context: {
        ...bounded,
        metadata: {
          ...bounded.metadata,
          projectionStatus: status,
          moreInfoSections: [...detailSections, 'raw'],
        },
      },
      status,
      originalBytes,
      projectedBytes: Buffer.byteLength(JSON.stringify(bounded.metadata)),
    };
  }
}
export function createInputProjections(
  history?: SessionHistory,
): InputProjections {
  return new InputProjectionsModule(history);
}
