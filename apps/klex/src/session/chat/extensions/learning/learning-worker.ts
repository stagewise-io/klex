import { randomUUID } from 'node:crypto';

import type { ToolSet } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  Extension,
  ExtensionDeps,
} from '@/session/chat/extensions/extension-api';
import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';
import type { Skill, SkillNamespaceHandle } from '@/skills';

import { createEpisodeInvestigation } from './episode-tools';
import {
  CONSOLIDATE_CHANGE_WEIGHT,
  FAILURE_RETRY_DELAYS_MS,
  INITIAL_BACKFILL_EPISODES,
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
import type { LearningState } from './learning-state';
import {
  type SkillOperation,
  toSkill,
  validateOperations,
  type WriteOperation,
} from './operations';
import {
  type BuiltPrompt,
  buildConsolidationPrompt,
  buildExtractionPrompt,
  isStale,
  lastActiveTurn,
  type PromptAgent,
  sourceEpisodesOf,
} from './prompts';
import { createLearningSubmissionTools } from './submission-tools';

export interface LearningWorkerOptions {
  episodes: EpisodeFeed;
  /** The learning namespace of the core skill registry. */
  skills: SkillNamespaceHandle;
  /** Cursor and consolidation bookkeeping; skill usage lives in the registry. */
  state: LearningState;
  createChildSession: ExtensionDeps['createChildSession'];
  getModelPurpose: () => 'memory' | 'chat';
  getAgent: () => PromptAgent;
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
  private child: ChildSessionHandle | undefined;
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
    await this.child?.close();
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
      skillCount: this.options.skills.list().length,
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
      if (!ref || this.closed) break;
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
    }
    if (!this.closed && result === 'idle') {
      if (!(await this.revisitDeferred())) return 'retry-later';
      await this.maybeConsolidate();
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
    if (this.closed) return null;
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
    const { episodes, skills, logger } = this.options;
    const page =
      supplied === undefined
        ? await episodes.readPage(id, {
            offset: 0,
            limit: MAX_EPISODE_CHARACTERS,
            maxBytes: 2_000_000,
            tail: true,
          })
        : supplied;
    // Shutdown may have begun while the episode reader was awaiting I/O.
    if (this.closed) return 'stop';
    if (!page) return this.recordFailure(id, 'Episode page unavailable');
    const episode =
      page.startedAt && page.endedAt
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
      '[Partial episode: scan or character budget exhausted; omitted content is not evidence.]\n';
    const { system, prompt } = buildExtractionPrompt({
      agent: this.options.getAgent(),
      skills: skills.list(),
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
    let outcome: EpisodeOutcome = 'unchanged';
    const submission = createLearningSubmissionTools({
      evidence: investigation.evidence,
      getExistingNames: () => skills.list().map((skill) => skill.name),
      allowDefer: true,
      allowCreate: true,
      signal: controller.signal,
      persist: async (batch) => {
        if (batch.deferred) {
          await this.options.state.update((draft) => {
            const existing = draft.deferred.find((item) => item.id === id);
            const after = revisit ? (draft.cursor ?? id) : id;
            if (existing) existing.after = after;
            else {
              if (draft.deferred.length >= 20) draft.deferred.shift();
              draft.deferred.push({ id, after, attempts: 0 });
            }
          });
          outcome = 'deferred';
          return 0;
        }
        const applied = await this.persist(batch.operations, id);
        outcome = applied > 0 ? 'changed' : 'unchanged';
        logger.info({ episode: id, applied }, 'Learned from episode');
        return applied;
      },
    });
    await this.investigate(
      'extraction',
      {
        system: `${system}\n\n${submission.instructions}`,
        prompt,
      },
      { ...investigation.tools, ...submission.tools },
    );
    if (this.closed) return 'stop';
    if (!revisit) await this.advance(id);
    return outcome;
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
   * Applies validated operations through the registry; returns how many were
   * applied. Provenance lives in the namespace metadata, so content and
   * sources are written together.
   */
  private async apply(
    operations: readonly SkillOperation[],
    sourceEpisode: string | null,
  ): Promise<number> {
    const { skills, state, logger } = this.options;
    const { accepted, rejected } = validateOperations(
      operations,
      skills.list().map((skill) => skill.name),
    );
    for (const { operation, reason } of rejected) {
      logger.debug(
        { op: operation.op, skill: operation.name, reason },
        'Rejected skill operation',
      );
    }
    // Merged skills may be deleted before the survivor's update runs.
    const before = new Map(
      skills.list().map((skill) => [skill.name, sourceEpisodesOf(skill)]),
    );
    let applied = 0;
    for (const operation of accepted) {
      if (this.closed) break;
      if (operation.op === 'delete') {
        await skills.delete(operation.name);
      } else {
        const next = toSkill(operation);
        const existing = skills.get(operation.name);
        const material =
          !existing ||
          existing.description !== next.description ||
          existing.body !== next.body;
        const previousSources = existing ? sourceEpisodesOf(existing) : [];
        const sources = this.nextSources(
          operation,
          previousSources,
          before,
          sourceEpisode,
        );
        const newEvidence = sources.some((id) => !previousSources.includes(id));
        if (
          !material &&
          !newEvidence &&
          (operation.op !== 'update' || !operation.mergedFrom?.length)
        )
          continue;
        const metadata = {
          ...(existing?.metadata ?? {}),
          sourceEpisodes: sources,
        };
        // Citations alone are no refresh: metadata writes keep `updated*`.
        if (material || !existing)
          await skills.put(
            operation.name,
            { description: next.description, body: next.body },
            { metadata },
          );
        else await skills.setMetadata(operation.name, metadata);
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
    try {
      await this.consolidate();
    } catch (error) {
      if (!this.closed) {
        await this.spaceConsolidation();
        this.options.logger.warn({ error }, 'Skill consolidation failed');
      }
    } finally {
      this.abort = undefined;
      if (!this.closed) await this.enforceCap();
    }
  }

  private async consolidate(): Promise<void> {
    const { skills: handle, state, logger } = this.options;
    const skills = handle.list();
    if (skills.length < 2) return;
    const current = state.get();
    const currentTurn = handle.currentTurn();
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
        skills.some((skill) => isStale(skill, currentTurn)));
    if (!due) return;

    const { system, prompt } = buildConsolidationPrompt({
      agent: this.options.getAgent(),
      skills,
      currentTurn,
    });
    const controller = new AbortController();
    this.abort = controller;
    const investigation = createEpisodeInvestigation(
      this.options.episodes,
      controller.signal,
      null,
    );
    let submitted = false;
    const submission = createLearningSubmissionTools({
      evidence: investigation.evidence,
      getExistingNames: () => handle.list().map((skill) => skill.name),
      allowDefer: false,
      allowCreate: false,
      signal: controller.signal,
      persist: async (batch) => {
        const applied = await this.persist(batch.operations, null);
        await state.update((draft) => {
          draft.pendingChangeWeight = 0;
          draft.lastConsolidationEpisode = draft.processedEpisodeCount;
          draft.lastConsolidationSkillCount = handle.list().length;
          draft.consolidationFailures = 0;
          draft.nextConsolidationEpisode = null;
          draft.lastConsolidationAt = new Date(this.now()).toISOString();
        });
        submitted = true;
        logger.info(
          { applied, skills: handle.list().length },
          'Consolidated skills',
        );
        return applied;
      },
    });
    await this.investigate(
      'consolidation',
      {
        system: `${system}\n\n${submission.instructions}`,
        prompt,
      },
      { ...investigation.tools, ...submission.tools },
    );
    if (!this.closed && !submitted) await this.spaceConsolidation();
  }

  private async spaceConsolidation(): Promise<void> {
    await this.options.state.update((draft) => {
      draft.nextConsolidationEpisode =
        draft.processedEpisodeCount + STALE_CONSOLIDATION_SPACING;
    });
  }

  private async persist(
    operations: readonly SkillOperation[],
    source: string | null,
  ): Promise<number> {
    try {
      return await this.apply(operations, source);
    } catch (error) {
      this.options.logger.warn(
        { error, episode: source },
        'Learning persistence failed',
      );
      throw error;
    } finally {
      await this.enforceCap();
    }
  }

  private async investigate(
    kind: 'extraction' | 'consolidation',
    task: BuiltPrompt,
    tools: ToolSet,
  ): Promise<void> {
    const child = await this.options.createChildSession({
      name: `learning-${kind}`,
      extensionIdentifier: 'io.stagewise/learning',
      basePrompt: task.system,
      modelPurpose: this.options.getModelPurpose(),
      extensions: [
        {
          identifier: 'io.stagewise/learning-investigation',
          create: () => createInvestigationExtension(tools),
        },
      ],
    });
    this.child = child;
    try {
      if (this.closed) return;
      child.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: task.prompt }],
        },
        SessionInboxUrgency.Default,
      );
      // This observes the ordinary session lifecycle; it is not a model budget.
      while (!this.closed && child.getSessionInfo().status !== 'terminated') {
        if (await child.waitForIdle(1_000)) break;
      }
    } finally {
      await child.close();
      this.child = undefined;
    }
  }

  /**
   * Sources of a written skill in episode order, capped so the oldest are
   * dropped across merged skills.
   */
  private nextSources(
    operation: WriteOperation,
    existing: readonly string[],
    before: ReadonlyMap<string, readonly string[]>,
    sourceEpisode: string | null,
  ): string[] {
    const merged =
      operation.op === 'update'
        ? (operation.mergedFrom ?? []).flatMap((name) => before.get(name) ?? [])
        : [];
    const candidates = [
      ...existing,
      ...merged,
      ...(sourceEpisode ? [sourceEpisode] : []),
      ...(operation.evidenceEpisodes ?? []),
    ];
    return [...new Set(candidates)]
      .sort((left, right) => this.options.episodes.compareIds(left, right))
      .slice(-MAX_SOURCE_EPISODES);
  }

  /**
   * Drops least-recently-used skills above `MAX_SKILLS`. Turns rank first;
   * dates break ties among skills active in the same turn, such as imports.
   */
  private async enforceCap(): Promise<void> {
    const { skills: handle, logger } = this.options;
    const skills = handle.list();
    if (skills.length <= MAX_SKILLS) return;
    const victims = [...skills]
      .sort(
        (left, right) =>
          lastActiveTurn(left) - lastActiveTurn(right) ||
          historicalUse(left) - historicalUse(right) ||
          left.readCount - right.readCount ||
          (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      )
      .slice(0, skills.length - MAX_SKILLS);
    for (const { name } of victims) {
      await handle.delete(name);
      logger.info({ skill: name }, 'Evicted least-recently-used skill');
    }
  }
}

function historicalUse(skill: Skill): number {
  const values = [skill.lastReadAt ?? skill.createdAt, skill.updatedAt]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : 0;
}

class InvestigationExtension implements Extension {
  constructor(private readonly tools: ToolSet) {}
  getTools(): ToolSet {
    return this.tools;
  }
}

function createInvestigationExtension(tools: ToolSet): Extension {
  return new InvestigationExtension(tools);
}

export function createLearningWorker(
  options: LearningWorkerOptions,
): LearningWorker {
  return new LearningWorkerModule(options);
}
