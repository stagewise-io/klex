import type { ModuleLogger } from '@stagewise/logger';

import type {
  GenerateTextArgs,
  GenerateTextResult,
} from '@/session/chat/extensions/extension-api';
import type { EpisodeFeed } from '@/session/chat/extensions/memory';

import { createEpisodeInvestigation } from './episode-tools';
import {
  CONSOLIDATE_CHANGE_WEIGHT,
  CONSOLIDATION_MAX_OUTPUT_TOKENS,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  FAILURE_RETRY_DELAYS_MS,
  INITIAL_BACKFILL_EPISODES,
  INVESTIGATION_MAX_STEPS,
  MAX_EPISODE_CHARACTERS,
  MAX_FAILURES_PER_EPISODE,
  MAX_SKILLS,
  MAX_SOURCE_EPISODES,
  MIN_EPISODE_CHARACTERS,
  PRIMARY_PASS_CHARACTERS,
  SOFT_SKILL_COUNT,
  SOFT_THRESHOLD_CHANGE_WEIGHT,
  STALE_CONSOLIDATION_SPACING,
} from './learning-config';
import type {
  LearningState,
  LearningStateData,
  SkillState,
} from './learning-state';
import {
  parseOperations,
  type SkillOperation,
  toSkill,
  validateOperations,
} from './operations';
import {
  buildConsolidationPrompt,
  buildExtractionPrompt,
  isStale,
} from './prompts';
import type { SkillStore } from './skill-store';

export interface LearningWorkerOptions {
  episodes: EpisodeFeed;
  store: SkillStore;
  state: LearningState;
  generateText: (args: GenerateTextArgs) => Promise<GenerateTextResult>;
  getModels: () => GenerateTextArgs['modelIds'];
  logger: ModuleLogger;
  now?: () => number;
}

export type LearningRunResult =
  | 'unavailable'
  | 'idle'
  | 'processed'
  | 'retry-later'
  | 'failed';

export interface LearningWorkerIntrospection extends Record<string, unknown> {
  running: boolean;
  lastRunAt: string | null;
  lastRunResult: LearningRunResult | null;
  lastError: string | null;
  cursor: string | null;
  skillCount: number;
  changedRunsSinceConsolidation: number;
  lastConsolidationAt: string | null;
}

export interface LearningWorker {
  start(): void;
  close(): Promise<void>;
  /** One extraction pass; joins the in-flight run instead of overlapping. */
  runOnce(): Promise<LearningRunResult>;
  introspect(): LearningWorkerIntrospection;
}

type EpisodeOutcome = 'changed' | 'unchanged' | 'deferred' | 'stop';

/**
 * Agent-wide background loop: reads finished episodes in order, turns
 * lessons into skills, and periodically consolidates the skill set.
 * Logs names, counts, ids, and reasons only, never prompts or episode text.
 */
class LearningWorkerModule implements LearningWorker {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private dirty = false;
  private pumping = false;
  private recoveryFailures = 0;
  private abort: AbortController | undefined;
  private inFlight: Promise<LearningRunResult> | undefined;
  private closed = false;
  private lastRunAt: string | null = null;
  private lastRunResult: LearningRunResult | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: LearningWorkerOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.unsubscribe || this.closed) return;
    this.unsubscribe = this.options.episodes.subscribe(() => this.wake());
    this.wake();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.abort?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  runOnce(): Promise<LearningRunResult> {
    if (this.closed) return Promise.resolve('idle');
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  introspect(): LearningWorkerIntrospection {
    const state = this.options.state.get();
    return {
      running: this.inFlight !== undefined,
      lastRunAt: this.lastRunAt,
      lastRunResult: this.lastRunResult,
      lastError: this.lastError,
      cursor: state.cursor,
      skillCount: this.options.store.list().length,
      changedRunsSinceConsolidation: state.changedRunsSinceConsolidation,
      lastConsolidationAt: state.lastConsolidationAt,
      processedEpisodeCount: state.processedEpisodeCount,
      pendingChangeWeight: state.pendingChangeWeight,
      nextConsolidationEpisode: state.nextConsolidationEpisode,
      deferred: state.deferred,
    };
  }

  private wake(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pumping) return;
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
      if (this.dirty && !this.closed) this.wake();
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.dirty) {
      this.dirty = false;
      const processedBefore = this.options.state.get().processedEpisodeCount;
      const result = await this.runOnce();
      if (this.closed) return;
      if (result === 'processed') {
        this.recoveryFailures = 0;
        this.dirty = true;
      } else if (result === 'retry-later' || result === 'failed') {
        if (this.options.state.get().processedEpisodeCount > processedBefore)
          this.recoveryFailures = 0;
        const delay = FAILURE_RETRY_DELAYS_MS[this.recoveryFailures++];
        if (delay !== undefined && !this.dirty) {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.wake();
          }, delay);
          this.timer.unref?.();
        } else if (delay === undefined && !this.dirty) {
          this.options.logger.warn(
            { failures: this.recoveryFailures },
            'Learning recovery retries exhausted; waiting for episode activity or restart',
          );
        }
      } else this.recoveryFailures = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async run(): Promise<LearningRunResult> {
    let result: LearningRunResult;
    try {
      result = await this.runSteps();
      this.lastError = null;
    } catch (error) {
      result = 'failed';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        { error: this.lastError },
        'Learning run failed',
      );
    }
    this.lastRunAt = new Date(this.now()).toISOString();
    this.lastRunResult = result;
    return result;
  }

  private async runSteps(): Promise<LearningRunResult> {
    const { episodes, state } = this.options;
    if (!episodes.isAvailable()) return 'unavailable';
    await this.backfillCursor();
    let result: LearningRunResult = 'idle';
    let characters = 0;
    while (!this.closed && characters < PRIMARY_PASS_CHARACTERS) {
      const [ref] = await episodes.listCompleted(state.get().cursor, 1);
      if (!ref) break;
      result = 'processed';
      let outcome: EpisodeOutcome;
      try {
        const page = await episodes.readPage(ref.id, {
          offset: 0,
          limit: MAX_EPISODE_CHARACTERS,
          maxBytes: 2_000_000,
          tail: true,
        });
        characters += Math.max(MIN_EPISODE_CHARACTERS, page?.text.length ?? 0);
        outcome = await this.processEpisode(ref.id, false, page);
      } catch (error) {
        if (this.closed) break;
        characters += MIN_EPISODE_CHARACTERS;
        outcome = await this.recordFailure(
          ref.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (this.closed) break;
      if (outcome === 'stop') {
        result = 'retry-later';
        break;
      }
      if (!(await this.revisitDeferred())) {
        result = 'retry-later';
        break;
      }
      if (!this.closed) await this.maybeConsolidate();
      if (!this.closed) await this.enforceCap();
    }
    if (!this.closed && result === 'idle') {
      if (!(await this.revisitDeferred())) return 'retry-later';
      await this.maybeConsolidate();
      await this.enforceCap();
    }
    return result;
  }

  /**
   * Without a cursor, pins the backfill window by persisting the cursor
   * just before the newest `INITIAL_BACKFILL_EPISODES`. Later runs then
   * continue from there instead of re-picking the newest episodes. A
   * recorded failure without a cursor means learning already started from
   * the beginning; re-pinning then could jump past the failed episode.
   */
  private async backfillCursor(): Promise<string | null> {
    const { episodes, state } = this.options;
    const { cursor, episodeFailures } = state.get();
    if (cursor !== null) return cursor;
    if (Object.keys(episodeFailures).length > 0) return null;
    const latest = await episodes.listLatestCompleted(
      INITIAL_BACKFILL_EPISODES + 1,
    );
    if (latest.length <= INITIAL_BACKFILL_EPISODES) return null;
    const start = latest[0]?.id ?? null;
    await state.update((draft) => {
      draft.cursor = start;
    });
    return start;
  }

  private async processEpisode(
    id: string,
    revisit = false,
    supplied?: Awaited<ReturnType<EpisodeFeed['readPage']>>,
  ): Promise<EpisodeOutcome> {
    try {
      return await this.processEpisodeSteps(id, revisit, supplied);
    } catch (error) {
      if (this.closed) return 'stop';
      return this.recordFailure(
        id,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.abort = undefined;
    }
  }

  private async processEpisodeSteps(
    id: string,
    revisit: boolean,
    supplied?: Awaited<ReturnType<EpisodeFeed['readPage']>>,
  ): Promise<EpisodeOutcome> {
    const { episodes, store, logger } = this.options;
    const page =
      supplied === undefined
        ? await episodes.readPage(id, {
            offset: 0,
            limit: MAX_EPISODE_CHARACTERS,
            maxBytes: 2_000_000,
            tail: true,
          })
        : supplied;
    const episode =
      page?.startedAt && page.endedAt
        ? { ...page, startedAt: page.startedAt, endedAt: page.endedAt }
        : null;
    if (
      page?.truncated &&
      (!episode || episode.text.length < MIN_EPISODE_CHARACTERS)
    )
      return this.recordFailure(
        id,
        'Episode scan budget exhausted without enough complete evidence',
      );
    if (!episode || episode.text.length < MIN_EPISODE_CHARACTERS) {
      logger.debug({ episode: id }, 'Skipping short or empty episode');
      if (!revisit) await this.advance(id);
      return 'unchanged';
    }

    const partialMarker =
      '[Partial episode: scan budget exhausted; uninspected content is not evidence.]\n';
    const { system, prompt } = buildExtractionPrompt({
      skills: store.list(),
      episode: {
        ...episode,
        text: episode.truncated
          ? `${partialMarker}${episode.text.slice(-(MAX_EPISODE_CHARACTERS - partialMarker.length))}`
          : episode.text,
      },
    });
    const controller = new AbortController();
    this.abort = controller;
    const investigation = createEpisodeInvestigation(
      episodes,
      controller.signal,
      id,
    );
    const generated = await this.options.generateText({
      modelIds: this.options.getModels(),
      system,
      prompt,
      maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      tools: investigation.tools,
      maxSteps: INVESTIGATION_MAX_STEPS,
      abortSignal: controller.signal,
    });
    this.abort = undefined;
    if (this.closed || controller.signal.aborted) return 'stop';
    const parsed = generated.success
      ? parseOperations(generated.text, {
          allowDelete: false,
          evidence: investigation.evidence,
        })
      : null;
    if (!parsed?.ok) {
      const reason = !generated.success
        ? generated.failureReason
        : parsed && !parsed.ok
          ? parsed.error
          : 'unknown';
      return this.recordFailure(id, reason);
    }

    if (parsed.deferred) {
      await this.options.state.update((draft) => {
        const existing = draft.deferred.find((item) => item.id === id);
        const after = revisit ? (draft.cursor ?? id) : id;
        if (existing) existing.after = after;
        else {
          if (draft.deferred.length >= 20) {
            const dropped = draft.deferred.shift();
            logger.debug(
              { episode: dropped?.id },
              'Deferred queue full; dropped oldest candidate',
            );
          }
          draft.deferred.push({ id, after, attempts: 0 });
        }
      });
      if (!revisit) await this.advance(id);
      return 'deferred';
    }
    let applied: number;
    try {
      applied = await this.apply(parsed.operations, id);
    } catch (error) {
      return this.recordFailure(
        id,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!revisit) await this.advance(id);
    logger.info(
      { episode: id, applied, dropped: parsed.dropped },
      'Learned from episode',
    );
    return applied > 0 ? 'changed' : 'unchanged';
  }

  private async recordFailure(
    id: string,
    reason: string,
  ): Promise<EpisodeOutcome> {
    const { state, logger } = this.options;
    const next = await state.update((draft) => {
      draft.episodeFailures[id] = (draft.episodeFailures[id] ?? 0) + 1;
    });
    const failures = next.episodeFailures[id] ?? 0;
    if (failures < MAX_FAILURES_PER_EPISODE) {
      logger.debug(
        { episode: id, failures, reason },
        'Learning from episode failed',
      );
      return 'stop';
    }
    logger.warn(
      { episode: id, failures, reason },
      'Skipping episode after repeated learning failures',
    );
    await this.advance(id);
    return 'unchanged';
  }

  private async revisitDeferred(): Promise<boolean> {
    const { state, episodes, logger } = this.options;
    const cursor = state.get().cursor;
    if (!cursor) return true;
    for (const item of state.get().deferred) {
      if (this.closed || episodes.compareIds(cursor, item.after) <= 0) continue;
      if (item.attempts >= 3) {
        logger.debug(
          { episode: item.id },
          'Discarding unresolved deferred candidate',
        );
        await state.update((draft) => {
          draft.deferred = draft.deferred.filter(
            (entry) => entry.id !== item.id,
          );
        });
        continue;
      }
      const outcome = await this.processEpisode(item.id, true);
      if (outcome === 'stop') return false;
      await state.update((draft) => {
        delete draft.episodeFailures[item.id];
        const entry = draft.deferred.find(
          (candidate) => candidate.id === item.id,
        );
        if (entry) {
          entry.attempts++;
          entry.after = cursor;
        }
      });
      if (outcome === 'changed' || outcome === 'unchanged')
        await state.update((draft) => {
          draft.deferred = draft.deferred.filter(
            (entry) => entry.id !== item.id,
          );
        });
    }
    return true;
  }

  private async advance(id: string): Promise<void> {
    await this.options.state.update((draft) => {
      if (
        draft.cursor === null ||
        this.options.episodes.compareIds(id, draft.cursor) > 0
      ) {
        draft.cursor = id;
        draft.processedEpisodeCount += 1;
      }
      delete draft.episodeFailures[id];
    });
  }

  /**
   * Applies validated operations; returns how many were applied. State is
   * written before files: a crash in between leaves provenance for a file
   * that the retried operation then writes, never a file without provenance.
   * A failed write restores the previous state entry before rethrowing.
   */
  private async apply(
    operations: readonly SkillOperation[],
    sourceEpisode: string | null,
  ): Promise<number> {
    const { store, state, logger, episodes } = this.options;
    const compareIds = (left: string, right: string) =>
      episodes.compareIds(left, right);
    const { accepted, rejected } = validateOperations(
      operations,
      store.list().map((skill) => skill.name),
    );
    for (const { operation, reason } of rejected) {
      logger.debug(
        { op: operation.op, skill: operation.name, reason },
        'Rejected skill operation',
      );
    }
    // Merged skills may be deleted before the survivor's update runs.
    const before = state.get().skills;
    let applied = 0;
    for (const operation of accepted) {
      const at = new Date(this.now()).toISOString();
      if (operation.op === 'delete') {
        await store.delete(operation.name);
        await state.update((draft) =>
          recordOperation(draft, operation, {
            at,
            sourceEpisode,
            before,
            compareIds,
          }),
        );
      } else {
        const next = toSkill(operation);
        const skill = store
          .list()
          .find((entry) => entry.name === operation.name);
        const material =
          !skill ||
          skill.description !== next.description ||
          skill.body !== next.body;
        const previous = state.get().skills[operation.name];
        const newEvidence = operation.evidenceEpisodes?.some(
          (id) => !previous?.sourceEpisodes.includes(id),
        );
        if (
          !material &&
          !newEvidence &&
          (operation.op !== 'update' || !operation.mergedFrom?.length)
        )
          continue;
        await state.update((draft) => {
          recordOperation(draft, operation, {
            at,
            sourceEpisode,
            before,
            compareIds,
          });
          const recorded = draft.skills[operation.name];
          // Citations alone are not a substantive refresh of the skill.
          if (!material && previous && recorded) {
            recorded.updatedAt = previous.updatedAt;
            recorded.updatedEpisode = previous.updatedEpisode;
          }
        });
        try {
          if (material) await store.write(next);
        } catch (error) {
          // Keep reads recorded while the write was in flight.
          await state.update((draft) => {
            const current = draft.skills[operation.name];
            if (previous) {
              draft.skills[operation.name] = {
                ...previous,
                lastReadAt: current?.lastReadAt ?? previous.lastReadAt,
                lastReadEpisode:
                  current?.lastReadEpisode == null &&
                  previous.lastReadEpisode == null
                    ? null
                    : Math.max(
                        current?.lastReadEpisode ?? 0,
                        previous.lastReadEpisode ?? 0,
                      ),
                readCount: Math.max(
                  current?.readCount ?? 0,
                  previous.readCount,
                ),
              };
            } else delete draft.skills[operation.name];
          });
          throw error;
        }
        if (sourceEpisode && material)
          await state.update((draft) => {
            draft.pendingChangeWeight += operation.op === 'create' ? 2 : 1;
          });
      }
      logger.info(
        { op: operation.op, skill: operation.name, episode: sourceEpisode },
        'Applied skill operation',
      );
      applied += 1;
    }
    return applied;
  }

  private async maybeConsolidate(): Promise<void> {
    const { store, state, logger } = this.options;
    const skills = store.list();
    if (skills.length < 2) return;
    const current = state.get();
    const overflow = skills.length > MAX_SKILLS;
    if (
      !overflow &&
      current.nextConsolidationEpisode !== null &&
      current.processedEpisodeCount < current.nextConsolidationEpisode
    )
      return;
    const due =
      overflow ||
      current.pendingChangeWeight >= CONSOLIDATE_CHANGE_WEIGHT ||
      (skills.length >= SOFT_SKILL_COUNT &&
        (current.lastConsolidationSkillCount < SOFT_SKILL_COUNT ||
          current.pendingChangeWeight >= SOFT_THRESHOLD_CHANGE_WEIGHT)) ||
      (current.processedEpisodeCount - current.lastConsolidationEpisode >=
        STALE_CONSOLIDATION_SPACING &&
        skills.some((skill) =>
          isStale(current.skills[skill.name], current.processedEpisodeCount),
        ));
    if (!due) return;

    const { system, prompt } = buildConsolidationPrompt({
      skills,
      usage: current.skills,
      now: current.processedEpisodeCount,
    });
    const controller = new AbortController();
    this.abort = controller;
    const investigation = createEpisodeInvestigation(
      this.options.episodes,
      controller.signal,
      null,
    );
    const generated = await this.options.generateText({
      modelIds: this.options.getModels(),
      system,
      prompt,
      maxOutputTokens: CONSOLIDATION_MAX_OUTPUT_TOKENS,
      tools: investigation.tools,
      maxSteps: INVESTIGATION_MAX_STEPS,
      abortSignal: controller.signal,
    });
    this.abort = undefined;
    if (this.closed || controller.signal.aborted) return;
    const parsed = generated.success
      ? parseOperations(generated.text, {
          allowDelete: true,
          evidence: investigation.evidence,
        })
      : null;
    if (!parsed?.ok) {
      await this.recordConsolidationFailure();
      logger.warn(
        {
          reason: generated.success
            ? 'unparseable reply'
            : generated.failureReason,
        },
        'Skill consolidation failed',
      );
      return;
    }
    let applied: number;
    try {
      applied = await this.apply(parsed.operations, null);
    } catch (error) {
      await this.recordConsolidationFailure();
      logger.warn({ error }, 'Skill consolidation write failed');
      return;
    }
    await state.update((draft) => {
      draft.pendingChangeWeight = 0;
      draft.lastConsolidationEpisode = draft.processedEpisodeCount;
      draft.lastConsolidationSkillCount = store.list().length;
      draft.consolidationFailures = 0;
      draft.nextConsolidationEpisode = null;
      draft.lastConsolidationAt = new Date(this.now()).toISOString();
    });
    logger.info(
      { applied, skills: store.list().length },
      'Consolidated skills',
    );
  }

  private async recordConsolidationFailure(): Promise<void> {
    await this.options.state.update((draft) => {
      const spacing = Math.min(
        8,
        2 ** Math.min(3, draft.consolidationFailures),
      );
      draft.consolidationFailures += 1;
      draft.nextConsolidationEpisode = draft.processedEpisodeCount + spacing;
    });
  }

  /** Drops least-recently-used skills above `MAX_SKILLS`. */
  private async enforceCap(): Promise<void> {
    const { store, state, logger } = this.options;
    const skills = store.list();
    if (skills.length <= MAX_SKILLS) return;
    const usage = state.get().skills;
    const lastUse = (name: string): number => {
      const entry = usage[name];
      if (!entry) return Number.NEGATIVE_INFINITY;
      return Math.max(
        entry.lastReadEpisode ?? 0,
        entry.updatedEpisode ?? 0,
        entry.createdEpisode ?? 0,
      );
    };
    // Migrated zero-position skills retain historical ordering without aging by time.
    const historicalUse = (name: string): number => {
      const entry = usage[name];
      return entry
        ? Math.max(
            Date.parse(entry.lastReadAt ?? entry.createdAt),
            Date.parse(entry.updatedAt),
            Date.parse(entry.createdAt),
          )
        : 0;
    };
    const victims = skills
      .map((skill) => skill.name)
      .sort(
        (left, right) =>
          lastUse(left) - lastUse(right) ||
          (lastUse(left) === 0 && lastUse(right) === 0
            ? historicalUse(left) - historicalUse(right)
            : 0) ||
          (usage[left]?.readCount ?? 0) - (usage[right]?.readCount ?? 0) ||
          (left < right ? -1 : left > right ? 1 : 0),
      )
      .slice(0, skills.length - MAX_SKILLS);
    for (const name of victims) {
      await store.delete(name);
      await state.update((draft) => {
        delete draft.skills[name];
      });
      logger.info({ skill: name }, 'Evicted least-recently-used skill');
    }
  }
}

interface RecordContext {
  at: string;
  sourceEpisode: string | null;
  /** Skill state before the batch; merged skills may already be deleted. */
  before: Readonly<Record<string, SkillState>>;
  compareIds: (left: string, right: string) => number;
}

function recordOperation(
  draft: LearningStateData,
  operation: SkillOperation,
  { at, sourceEpisode, before, compareIds }: RecordContext,
): void {
  if (operation.op === 'delete') {
    delete draft.skills[operation.name];
    return;
  }
  const existing =
    operation.op === 'update' ? draft.skills[operation.name] : undefined;
  const merged =
    operation.op === 'update'
      ? (operation.mergedFrom ?? []).flatMap(
          (name) => before[name]?.sourceEpisodes ?? [],
        )
      : [];
  const candidates = [
    ...(existing?.sourceEpisodes ?? []),
    ...merged,
    ...(sourceEpisode ? [sourceEpisode] : []),
    ...(operation.evidenceEpisodes ?? []),
  ];
  // Episode order, so the cap drops the oldest sources across merged skills.
  const nextSources = [...new Set(candidates)]
    .sort(compareIds)
    .slice(-MAX_SOURCE_EPISODES);
  draft.skills[operation.name] = {
    ...existing,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    lastReadAt: existing?.lastReadAt ?? null,
    readCount: existing?.readCount ?? 0,
    sourceEpisodes: nextSources,
    createdEpisode: existing?.createdEpisode ?? draft.processedEpisodeCount,
    updatedEpisode: draft.processedEpisodeCount,
    lastReadEpisode: existing?.lastReadEpisode ?? null,
  };
}

export function createLearningWorker(
  options: LearningWorkerOptions,
): LearningWorker {
  return new LearningWorkerModule(options);
}
