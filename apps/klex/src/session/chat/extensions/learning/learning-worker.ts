import { randomUUID } from 'node:crypto';

import type { ToolSet } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import {
  type ActivityBatch,
  type ActivityHistory,
  activityOrdinal,
} from '@/activity-history';
import type {
  Extension,
  ExtensionDeps,
} from '@/session/chat/extensions/extension-api';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';
import {
  MAX_METADATA_BYTES,
  type Skill,
  type SkillNamespaceHandle,
} from '@/skills';

import { createActivityInvestigation } from './activity-tools';
import {
  CONSOLIDATE_EVERY_RUNS,
  MAX_EPISODE_CHARACTERS,
  MAX_FAILURES_PER_EPISODE,
  MAX_SKILLS,
  MAX_SOURCE_EPISODES,
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
  lastActiveTurn,
  type PromptAgent,
  sourceEpisodesOf,
} from './prompts';
import { createLearningSubmissionTools } from './submission-tools';

export interface LearningWorkerOptions {
  activities: ActivityHistory;
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
  /**
   * A context compaction is about to drop these messages. Learning runs once
   * over everything from its cursor up to the newest dropped message.
   * Resolves once the boundary is resolved and the resulting run has settled;
   * callers on the compaction path must not await it.
   */
  onCompaction(droppedMessageIds: readonly string[]): Promise<void>;
  close(): Promise<void>;
  /** One extraction pass; joins the in-flight run instead of overlapping. */
  runOnce(): Promise<LearningRunResult>;
  introspect(): LearningWorkerIntrospection;
}

type EpisodeOutcome = 'changed' | 'unchanged' | 'stop';

type EpisodePage = ActivityBatch;

/**
 * Agent-wide background loop: on each context compaction, reads the activity
 * that compaction drops, turns lessons into skills, and consolidates the skill
 * set every few runs.
 * Logs names, counts, ids, and reasons only, never prompts or episode text.
 */
class LearningWorkerModule implements LearningWorker {
  /**
   * Pending jobs, oldest first. Each is the newest activity one compaction
   * dropped; a job covers everything from the cursor up to it. Not persisted:
   * after a restart the next compaction re-covers the gap from the cursor.
   */
  private readonly queue: string[] = [];
  private started = false;
  private rerun = false;
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
    if (this.started || this.closed) return;
    this.started = true;
  }

  async onCompaction(droppedMessageIds: readonly string[]): Promise<void> {
    if (this.closed || !this.started) return;
    let id: string | null;
    try {
      id = await this.options.activities.resolveBoundary(droppedMessageIds);
    } catch (error) {
      this.options.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Resolving compaction boundary failed',
      );
      return;
    }
    if (!id || this.closed) return;
    const { activities } = this.options;
    await this.seedCursor(droppedMessageIds);
    if (this.closed) return;
    const last = this.queue.at(-1);
    if (last === undefined || activities.compareIds(id, last) > 0)
      this.queue.push(id);
    await this.kick();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
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
    };
  }

  /**
   * Starts a run, or asks the running one to look again. A failed run is not
   * retried on a timer; the next compaction re-covers the unconsumed range.
   */
  private async kick(): Promise<void> {
    if (this.closed) return;
    if (this.inFlight) {
      this.rerun = true;
      await this.inFlight;
      return;
    }
    do {
      this.rerun = false;
      await this.runOnce();
    } while (this.rerun && !this.closed);
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
    const { activities, state } = this.options;
    if (!activities.isAvailable()) return 'unavailable';
    await this.cutoverLegacyCursor();
    let result: LearningRunResult = 'idle';
    while (!this.closed) {
      const boundary = this.queue[0];
      if (boundary === undefined) break;
      const cursor = state.get().cursor;
      if (cursor !== null && activities.compareIds(cursor, boundary) >= 0) {
        await this.finishJob();
        continue;
      }
      // One job's range, read in chunks that fit a model context. The cursor
      // moves only after a chunk succeeds, so the job resumes where it stopped.
      const pending = await activities.readRange(
        cursor,
        boundary,
        MAX_EPISODE_CHARACTERS,
      );
      if (!pending || this.closed) {
        if (!this.closed) await this.finishJob();
        continue;
      }
      result = 'processed';
      let outcome: EpisodeOutcome;
      try {
        outcome = await this.processEpisode(pending.id, pending);
      } catch (error) {
        if (this.closed) break;
        outcome = await this.recordFailure(
          pending.id,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (this.closed) break;
      if (outcome === 'stop') {
        result = 'retry-later';
        break;
      }
    }
    return result;
  }

  /** Ends the head job; consolidates every `CONSOLIDATE_EVERY_RUNS` jobs. */
  private async finishJob(): Promise<void> {
    this.queue.shift();
    const { runs } = await this.options.state
      .update((draft) => {
        draft.changedRunsSinceConsolidation += 1;
      })
      .then((next) => ({ runs: next.changedRunsSinceConsolidation }));
    if (!this.closed) await this.maybeConsolidate(runs);
  }

  /**
   * Without a cursor nothing was learned yet. Start right before the oldest
   * dropped message so the first run covers that compaction only, not all
   * history.
   */
  private async seedCursor(
    droppedMessageIds: readonly string[],
  ): Promise<void> {
    const { activities, state } = this.options;
    if (state.get().cursor !== null) return;
    try {
      for (const messageId of droppedMessageIds.slice(0, 2)) {
        const first = await activities.resolveBoundary([messageId]);
        if (!first) continue;
        const manifest = await activities.manifest();
        const index = manifest.findIndex((source) => source.id === first);
        const before = index > 0 ? manifest[index - 1]!.id : null;
        if (before === null) return;
        await state.update((draft) => {
          draft.cursor ??= before;
        });
        return;
      }
    } catch (error) {
      this.options.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Seeding learning cursor failed',
      );
    }
  }

  /** Replaces a pre-canonical cursor by the newest activity. */
  private async cutoverLegacyCursor(): Promise<string | null> {
    const { activities, state } = this.options;
    const { cursor } = state.get();
    if (cursor !== null && activityOrdinal(cursor) === null) {
      const latest = (await activities.latest(1)).at(-1)?.id ?? null;
      await state.update((draft) => {
        draft.cursor = latest;
        draft.episodeFailures = {};
      });
      return latest;
    }
    return cursor;
  }

  private async processEpisode(
    id: string,
    page: EpisodePage,
  ): Promise<EpisodeOutcome> {
    try {
      return await this.processEpisodeSteps(id, page);
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
    page: EpisodePage,
  ): Promise<EpisodeOutcome> {
    const { activities, skills, logger } = this.options;
    if (this.closed) return 'stop';
    if (!page.text) {
      logger.debug({ episode: id }, 'Skipping chunk without text');
      await this.advance(id);
      return 'unchanged';
    }

    const partialMarker =
      '[Partial episode: scan or character budget exhausted; omitted content is not evidence.]\n';
    const { system, prompt } = buildExtractionPrompt({
      agent: this.options.getAgent(),
      skills: skills.list(),
      episode: {
        ...page,
        text: page.truncated
          ? `${partialMarker}${page.text.slice(-(MAX_EPISODE_CHARACTERS - partialMarker.length))}`
          : page.text,
      },
    });
    const controller = new AbortController();
    this.abort = controller;
    const investigation = createActivityInvestigation(
      activities,
      controller.signal,
      page.sourceIds ?? id,
    );
    let outcome: EpisodeOutcome = 'unchanged';
    const submission = createLearningSubmissionTools({
      evidence: investigation.evidence,
      getExistingNames: () => skills.list().map((skill) => skill.name),
      allowCreate: true,
      signal: controller.signal,
      persist: async (batch) => {
        const operations = batch.operations.map((operation) =>
          operation.op === 'delete'
            ? operation
            : {
                ...operation,
                evidenceEpisodes: [
                  ...new Set([
                    ...(page.sourceIds ?? [id]),
                    ...(operation.evidenceEpisodes ?? []),
                  ]),
                ].slice(-6),
              },
        );
        const applied = await this.persist(operations, id);
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
    await this.advance(id);
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

  private async advance(id: string): Promise<void> {
    await this.options.state.update((draft) => {
      if (
        draft.cursor === null ||
        this.options.activities.compareIds(id, draft.cursor) > 0
      ) {
        draft.cursor = id;
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
    const { skills, logger } = this.options;
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
        const metadata: Record<string, unknown> = {
          ...(existing?.metadata ?? {}),
          sourceEpisodes: sources,
        };
        // Canonical handles can be large, and unrelated namespace metadata
        // shares the registry's byte budget. Keep the newest provenance that fits.
        while (
          sources.length &&
          Buffer.byteLength(JSON.stringify(metadata), 'utf8') >
            MAX_METADATA_BYTES
        )
          sources.shift();
        if (
          Buffer.byteLength(JSON.stringify(metadata), 'utf8') >
          MAX_METADATA_BYTES
        )
          delete metadata.sourceEpisodes;
        // Citations alone are no refresh: metadata writes keep `updated*`.
        if (material || !existing)
          await skills.put(
            operation.name,
            { description: next.description, body: next.body },
            { metadata },
          );
        else await skills.setMetadata(operation.name, metadata);
      }
      logger.info(
        { op: operation.op, skill: operation.name, episode: sourceEpisode },
        'Applied skill operation',
      );
      applied += 1;
    }
    return applied;
  }

  private async maybeConsolidate(runs: number): Promise<void> {
    if (runs < CONSOLIDATE_EVERY_RUNS) return;
    try {
      // Reset on attempt, not on success, so a no-op or failed attempt is
      // retried only after another `CONSOLIDATE_EVERY_RUNS` jobs.
      await this.options.state.update((draft) => {
        draft.changedRunsSinceConsolidation = 0;
      });
      // Shutdown may have happened while the update was pending.
      if (this.closed) return;
      await this.consolidate();
    } catch (error) {
      if (!this.closed) {
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
    const currentTurn = handle.currentTurn();

    const { system, prompt } = buildConsolidationPrompt({
      agent: this.options.getAgent(),
      skills,
      currentTurn,
    });
    const controller = new AbortController();
    this.abort = controller;
    const investigation = createActivityInvestigation(
      this.options.activities,
      controller.signal,
      null,
    );
    const submission = createLearningSubmissionTools({
      evidence: investigation.evidence,
      getExistingNames: () => handle.list().map((skill) => skill.name),
      allowCreate: false,
      signal: controller.signal,
      persist: async (batch) => {
        const applied = await this.persist(batch.operations, null);
        await state.update((draft) => {
          draft.changedRunsSinceConsolidation = 0;
          draft.lastConsolidationAt = new Date(this.now()).toISOString();
        });
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
      ...(operation.evidenceEpisodes ?? (sourceEpisode ? [sourceEpisode] : [])),
    ];
    return [...new Set(candidates)]
      .sort((left, right) => this.options.activities.compareIds(left, right))
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
