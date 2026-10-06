import type { ModuleLogger } from '@stagewise/logger';

import type {
  GenerateTextArgs,
  GenerateTextResult,
} from '@/session/chat/extensions/extension-api';
import type { EpisodeFeed } from '@/session/chat/extensions/memory';

import {
  CONSOLIDATE_AFTER_CHANGED_RUNS,
  CONSOLIDATE_MAX_INTERVAL_MS,
  CONSOLIDATION_MAX_OUTPUT_TOKENS,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  INITIAL_BACKFILL_EPISODES,
  MAX_EPISODES_PER_RUN,
  MAX_FAILURES_PER_EPISODE,
  MAX_SKILLS,
  MAX_SOURCE_EPISODES,
  MIN_EPISODE_CHARACTERS,
  RUN_INTERVAL_MS,
  STARTUP_DELAY_MS,
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
import { buildConsolidationPrompt, buildExtractionPrompt } from './prompts';
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

type EpisodeOutcome = 'changed' | 'unchanged' | 'stop';

/**
 * Agent-wide background loop: reads finished episodes in order, turns
 * lessons into skills, and periodically consolidates the skill set.
 * Logs names, counts, ids, and reasons only, never prompts or episode text.
 */
class LearningWorkerModule implements LearningWorker {
  private timer: NodeJS.Timeout | undefined;
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
    if (this.timer || this.closed) return;
    this.schedule(STARTUP_DELAY_MS);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  runOnce(): Promise<LearningRunResult> {
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
    };
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().finally(() => this.schedule(RUN_INTERVAL_MS));
    }, delay);
    this.timer.unref?.();
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
    const cursor = await this.backfillCursor();
    const refs = await episodes.listCompleted(cursor, MAX_EPISODES_PER_RUN);

    let result: LearningRunResult = refs.length === 0 ? 'idle' : 'processed';
    let changed = false;
    for (const ref of refs) {
      if (this.closed) break;
      const outcome = await this.processEpisode(ref.id);
      if (outcome === 'changed') changed = true;
      if (outcome === 'stop') {
        result = 'retry-later';
        break;
      }
    }
    // Counts runs, not episodes: consolidation is due after N changed runs.
    if (changed) {
      await state.update((draft) => {
        draft.changedRunsSinceConsolidation += 1;
      });
    }
    if (!this.closed) await this.maybeConsolidate();
    if (!this.closed) await this.enforceCap();
    return result;
  }

  /**
   * Without a cursor, pins the backfill window by persisting the cursor
   * just before the newest `INITIAL_BACKFILL_EPISODES`. Later runs then
   * continue from there instead of re-picking the newest episodes.
   */
  private async backfillCursor(): Promise<string | null> {
    const { episodes, state } = this.options;
    const cursor = state.get().cursor;
    if (cursor !== null) return cursor;
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

  private async processEpisode(id: string): Promise<EpisodeOutcome> {
    const { episodes, store, logger } = this.options;
    const episode = await episodes.read(id);
    if (!episode || episode.text.length < MIN_EPISODE_CHARACTERS) {
      logger.debug({ episode: id }, 'Skipping short or empty episode');
      await this.advance(id);
      return 'unchanged';
    }

    const { system, prompt } = buildExtractionPrompt({
      skills: store.list(),
      episode,
    });
    const generated = await this.options.generateText({
      modelIds: this.options.getModels(),
      system,
      prompt,
      maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    });
    const parsed = generated.success
      ? parseOperations(generated.text, { allowDelete: false })
      : null;
    if (!parsed?.ok) {
      const reason = !generated.success
        ? generated.failureReason
        : parsed && !parsed.ok
          ? parsed.error
          : 'unknown';
      return this.recordFailure(id, reason);
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
    await this.advance(id);
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

  private async advance(id: string): Promise<void> {
    await this.options.state.update((draft) => {
      draft.cursor = id;
      delete draft.episodeFailures[id];
    });
  }

  /**
   * Applies validated operations; returns how many were applied. State is
   * written before files: a crash in between leaves provenance for a file
   * that the retried operation then writes, never a file without provenance.
   */
  private async apply(
    operations: readonly SkillOperation[],
    sourceEpisode: string | null,
  ): Promise<number> {
    const { store, state, logger } = this.options;
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
          recordOperation(draft, operation, at, sourceEpisode, before),
        );
      } else {
        await state.update((draft) =>
          recordOperation(draft, operation, at, sourceEpisode, before),
        );
        await store.write(toSkill(operation));
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
    const lastAt =
      current.lastConsolidationAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(current.lastConsolidationAt);
    const due =
      current.changedRunsSinceConsolidation >= CONSOLIDATE_AFTER_CHANGED_RUNS ||
      (current.changedRunsSinceConsolidation > 0 &&
        this.now() - lastAt >= CONSOLIDATE_MAX_INTERVAL_MS) ||
      skills.length > MAX_SKILLS;
    if (!due) return;

    const { system, prompt } = buildConsolidationPrompt({
      skills,
      usage: current.skills,
      now: this.now(),
    });
    const generated = await this.options.generateText({
      modelIds: this.options.getModels(),
      system,
      prompt,
      maxOutputTokens: CONSOLIDATION_MAX_OUTPUT_TOKENS,
    });
    const parsed = generated.success
      ? parseOperations(generated.text, { allowDelete: true })
      : null;
    if (!parsed?.ok) {
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
    const applied = await this.apply(parsed.operations, null);
    await state.update((draft) => {
      draft.changedRunsSinceConsolidation = 0;
      draft.lastConsolidationAt = new Date(this.now()).toISOString();
    });
    logger.info(
      { applied, skills: store.list().length },
      'Consolidated skills',
    );
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
      return Date.parse(entry.lastReadAt ?? entry.createdAt);
    };
    const victims = skills
      .map((skill) => skill.name)
      .sort((left, right) => lastUse(left) - lastUse(right))
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

function recordOperation(
  draft: LearningStateData,
  operation: SkillOperation,
  at: string,
  sourceEpisode: string | null,
  before: Readonly<Record<string, SkillState>>,
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
  ];
  const nextSources = [...new Set(candidates)].slice(-MAX_SOURCE_EPISODES);
  draft.skills[operation.name] = {
    ...existing,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
    lastReadAt: existing?.lastReadAt ?? null,
    readCount: existing?.readCount ?? 0,
    sourceEpisodes: nextSources,
  };
}

export function createLearningWorker(
  options: LearningWorkerOptions,
): LearningWorker {
  return new LearningWorkerModule(options);
}
