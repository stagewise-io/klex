import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ToolSet } from 'ai';

import {
  type ActivityHistory,
  activityMessageId,
  activityOrdinal,
} from '@/activity-history';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';
import {
  createLearningState,
  importLegacySkills,
  LEARNING_SKILL_NAMESPACE,
} from '@/session/chat/extensions/learning';
import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';
import type { SkillRegistry } from '@/skills';

import { createEntityStore, type EntityStore } from './entities';
import { createWriterState, type WriterState } from './state';
import prompt from './system-prompt.md';
import { createWriterTools } from './tools';
import { writerView } from './view';

// Enabling memory on an existing bot must not replay its whole history on the user's budget.
const FIRST_RUN_MAX_AGE_MS = 21 * 24 * 60 * 60_000;
const FIRST_RUN_MAX_MESSAGES = 3_000;
// New history per chunk; the fixed prompt and tools dominate smaller chunks.
const CHUNK_CHARACTERS = 60_000;

/** Starting cursor for a first activation: only the newest 21 days, at most 3,000 messages. */
export function firstRunStart(
  sources: readonly { id: string; persistedAt: string }[],
  now: number,
): { cursor: string | null; skipped: number } {
  const capped = Math.max(0, sources.length - FIRST_RUN_MAX_MESSAGES);
  const index = sources.findIndex(
    (source, position) =>
      position >= capped &&
      Date.parse(source.persistedAt) >= now - FIRST_RUN_MAX_AGE_MS,
  );
  const start = index === -1 ? sources.length : index;
  return { cursor: sources[start - 1]?.id ?? null, skipped: start };
}

export interface MemoryWriterExtOptions {
  activities: ActivityHistory;
  skillReader: Pick<
    SkillRegistry,
    'list' | 'get' | 'readReference' | 'addDeletionGuard'
  >;
  legacyLearningDirectory: string;
  /** Bot's configured name, read per chunk. */
  selfName?: () => string | undefined;
}

class WriterToolsExtension implements Extension {
  constructor(
    private readonly get: () => ToolSet,
    readonly onStepComplete: (event: StepCompleteEvent) => void,
  ) {}
  getTools(): ToolSet {
    return this.get();
  }
}
function toolsExtension(
  get: () => ToolSet,
  complete: (event: StepCompleteEvent) => void,
): Extension {
  return new WriterToolsExtension(get, complete);
}

class MemoryWriterExtension implements Extension {
  private closed = false;
  private ready = false;
  private child: ChildSessionHandle | undefined;
  private tools: ToolSet = {};
  private abort: AbortController | undefined;
  private work = Promise.resolve();
  private running = false;
  private wakePending = false;
  private parentActive = false;
  private unsubscribe: (() => void) | undefined;
  private removeDeletionGuard: (() => void) | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private childCompleted = false;
  private readonly dataDirectory: string;
  private readonly state: WriterState;
  private readonly entities: EntityStore;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: MemoryWriterExtOptions,
  ) {
    this.dataDirectory = deps.getDataDir(true);
    this.state = createWriterState(this.dataDirectory);
    this.entities = createEntityStore(join(this.dataDirectory, 'entities'));
  }

  // Memory is not worth an outage: bad notes or a failed import pause the
  // writer instead of failing the session start.
  async onStart(): Promise<void> {
    if (this.ready || this.closed) return;
    try {
      await this.startWriter();
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Memory writer failed to start; paused until next start',
      );
    }
  }

  private async startWriter(): Promise<void> {
    if (!this.deps.skills)
      throw new Error('Memory writer requires the learning namespace');
    await this.state.start();
    await this.entities.start();
    const legacy = createLearningState(this.options.legacyLearningDirectory);
    await legacy.start();
    // LEGACY(skill-registry): preserve pre-0.28 learned skills before allowing new writes.
    const imported = await importLegacySkills({
      legacyRoot: join(this.options.legacyLearningDirectory, 'skills'),
      state: legacy,
      skills: this.deps.skills,
      logger: this.deps.logger,
    });
    if (imported.failed)
      throw new Error('Legacy skill import failed; memory writer paused');
    this.removeDeletionGuard = this.options.skillReader.addDeletionGuard(
      (id) => {
        const references = this.entities
          .list()
          .filter((entity) =>
            entity.frontmatter.RelatedTo.some(
              ({ target }) => target.kind === 'skill' && target.id === id,
            ),
          )
          .map((entity) => entity.id);
        if (references.length)
          throw new Error(
            `Cannot delete skill "${id}": referenced by entities ${references.join(', ')}`,
          );
      },
    );
    const brokenReferences = this.brokenReferences();
    if (brokenReferences.length)
      this.deps.logger.warn(
        { brokenReferences },
        'Memory contains broken references; stop the bot before repairing files',
      );
    this.ready = true;
    this.unsubscribe = this.options.activities.subscribe(() => {
      if (!this.parentActive) this.wake();
    });
    this.wake();
  }

  onStepStart(): void {
    this.parentActive = true;
  }

  onStepComplete(event: StepCompleteEvent): void {
    if (
      event.shouldContinue ||
      event.forceNextStep ||
      event.modelFallbackOccurred
    )
      return;
    this.parentActive = false;
    if (
      !event.generationFailed &&
      !event.fatalError &&
      !event.requestRejected &&
      !event.instinctAborted &&
      event.generation
    )
      this.wake();
  }

  onCheckpointApplied(): void {
    this.wake();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    clearTimeout(this.retry);
    this.abort?.abort();
    await this.child?.close();
    await this.work;
    await this.child?.close();
    this.child = undefined;
    this.removeDeletionGuard?.();
    this.removeDeletionGuard = undefined;
  }

  private brokenReferences() {
    return this.entities
      .list()
      .flatMap((entity) =>
        entity.frontmatter.RelatedTo.filter(({ target }) =>
          target.kind === 'entity'
            ? !this.entities.get(target.id)
            : !this.options.skillReader.get(target.id),
        ).map(({ target }) => ({ entityId: entity.id, target })),
      );
  }

  introspect(): Record<string, unknown> {
    return {
      ready: this.ready,
      state: this.state.get(),
      childSessionId: this.child?.sessionId ?? null,
      dataDirectory: this.dataDirectory,
      entitiesDirectory: join(this.dataDirectory, 'entities'),
      entityCount: this.entities.list().length,
      brokenReferences: this.brokenReferences(),
    };
  }

  private wake(): void {
    if (!this.ready || this.closed) return;
    this.wakePending = true;
    if (this.running || this.retry) return;
    this.running = true;
    this.work = (async () => {
      try {
        while (this.wakePending && !this.closed) {
          this.wakePending = false;
          const latest = (await this.options.activities.latest(1))[0];
          if (!latest || this.closed) continue;
          const first = this.state.get().initialized
            ? null
            : firstRunStart(
                await this.options.activities.manifest(),
                Date.now(),
              );
          if (first?.skipped)
            this.deps.logger.info(
              { skipped: first.skipped, cursor: first.cursor },
              'Memory writer first run skips history older than its initial window',
            );
          await this.state.update((draft) => {
            // Once initialized, a missing cursor means oldest retained history.
            if (!draft.initialized) {
              draft.initialized = true;
              draft.cursor ??= first?.cursor ?? null;
            }
            if (
              !draft.pendingThrough ||
              this.options.activities.compareIds(
                latest.id,
                draft.pendingThrough,
              ) > 0
            )
              draft.pendingThrough = latest.id;
          });
          await this.drain();
        }
      } catch (error) {
        this.deps.logger.warn(
          { error },
          'Memory writer failed; retrying oldest pending range',
        );
        if (!this.closed)
          this.retry = setTimeout(() => {
            this.retry = undefined;
            this.wake();
          }, 30_000);
      } finally {
        this.abort?.abort();
        this.tools = {};
        this.running = false;
        // A wake that arrived after the last loop check must not be dropped.
        if (this.wakePending && !this.retry && !this.closed)
          queueMicrotask(() => this.wake());
      }
    })();
  }

  private async drain(): Promise<void> {
    const { activities } = this.options;
    const skills = this.deps.skills;
    if (!skills) throw new Error('Missing learned skills handle');
    while (!this.closed && activities.isAvailable()) {
      const { cursor, pendingThrough } = this.state.get();
      if (!pendingThrough) return;
      if (cursor && activities.compareIds(cursor, pendingThrough) >= 0) {
        await this.state.update((draft) => {
          draft.pendingThrough = null;
        });
        return;
      }
      if (activityOrdinal(pendingThrough) === null)
        throw new Error('Invalid memory boundary');
      const batch = await activities.readRange(
        cursor,
        pendingThrough,
        CHUNK_CHARACTERS,
        true,
        writerView,
      );
      if (!batch) {
        // Retention can remove evidence while a job waits. Never invent missing facts.
        this.deps.logger.warn(
          { cursor, pendingThrough },
          'Memory writer range no longer retained; advancing unavailable boundary',
        );
        await this.state.update((draft) => {
          draft.cursor = pendingThrough;
          draft.pendingThrough = null;
        });
        return;
      }
      if (batch.truncated)
        this.deps.logger.warn(
          { after: cursor, through: batch.id },
          'Memory writer batch contains truncated or omitted activities; replay is incomplete for this range',
        );
      if (batch.text) {
        const firstSourceId = batch.firstSourceId;
        const previous = firstSourceId
          ? await Promise.all(
              (await activities.listNeighbors(firstSourceId, 2))
                .filter(
                  (source) =>
                    activities.compareIds(source.id, firstSourceId) < 0,
                )
                .sort((a, b) => activities.compareIds(a.id, b.id))
                .map((source) =>
                  activities.readPage(source.id, {
                    offset: 0,
                    limit: 1_200,
                    maxBytes: 2_000_000,
                    view: writerView,
                  }),
                ),
            )
          : [];
        const previousActivities = previous.filter(
          (page): page is NonNullable<typeof page> => Boolean(page?.text),
        );
        const sourceIds = new Set(
          [
            ...previousActivities.map((page) => page.id),
            ...(batch.sourceIds ?? []),
          ]
            .map(activityMessageId)
            .filter((id): id is string => id !== null),
        );
        const previousText = previousActivities
          .map(
            (page) =>
              `[${activityMessageId(page.id)}]\n${page.text}${page.nextOffset != null ? '\n[entry clipped]' : ''}`,
          )
          .join('\n\n');
        // Entry lines carry only the time; the wrapper and day changes carry the date.
        const date = batch.startedAt.slice(0, 10);
        let day = date;
        const newText = batch.text.replace(
          /^Source (history:[A-Za-z0-9_-]+) \(([^\n]*)\)\n/gm,
          (_header, id: string, persistedAt: string) => {
            const changed = persistedAt.slice(0, 10) !== day;
            day = persistedAt.slice(0, 10);
            return `[${activityMessageId(id)}]${changed ? ` ${day}` : ''}\n`;
          },
        );
        const selfName = this.options.selfName?.()?.trim() || undefined;
        this.abort = new AbortController();
        this.tools = createWriterTools({
          selfName,
          evidenceText: `${previousText}\n${batch.text}`,
          entities: this.entities,
          skills,
          skillReader: this.options.skillReader,
          activities,
          signal: this.abort.signal,
          view: writerView,
          sourceIds,
        }).tools;
        try {
          await this.createChild();
          if (this.closed) return;
          const child = this.child;
          if (!child) throw new Error('Memory writer child unavailable');
          this.childCompleted = false;
          child.inbox.sendMessage(
            {
              id: randomUUID(),
              role: 'user',
              parts: [
                {
                  type: 'text',
                  text: `${selfName ? `<self name="${selfName}"/>\n\n` : ''}<previous-activities>\n${previousText}\n</previous-activities>\n\n<new-activities date="${date}">\n${newText}\n</new-activities>`,
                },
              ],
            },
            SessionInboxUrgency.Default,
          );
          while (!this.closed) {
            if (child.getSessionInfo().status === 'terminated') {
              throw new Error('Memory writer session terminated');
            }
            if (await child.waitForIdle(1_000)) {
              if (child.getSessionInfo().status === 'terminated') {
                throw new Error('Memory writer terminated before settling');
              }
              if (!this.childCompleted)
                throw new Error('Memory writer did not complete successfully');
              break;
            }
          }
          if (this.closed) return;
        } finally {
          this.abort.abort();
          this.tools = {};
          const child = this.child;
          this.child = undefined;
          await child?.close();
        }
      }
      await this.state.update((draft) => {
        draft.cursor = batch.id;
      });
    }
  }

  private async createChild(): Promise<void> {
    const child = await this.deps.createChildSession({
      name: 'memory-writer',
      extensionIdentifier: 'io.stagewise/memory-writer',
      basePrompt: `${prompt.trimEnd()}\n\n${LINES_FORMAT_PROMPT}`,
      modelPurpose: 'memory',
      fallbackModelPurposes: ['chat'],
      extensions: [
        createContextCompactionExt,
        {
          identifier: 'io.stagewise/memory-writer-tools',
          create: () =>
            toolsExtension(
              () => this.tools,
              (event) => {
                if (
                  event.forceNextStep ||
                  event.generationFailed ||
                  event.fatalError ||
                  event.requestRejected ||
                  event.modelFallbackOccurred ||
                  event.instinctAborted
                ) {
                  this.childCompleted = false;
                } else if (event.generation) {
                  // Normal generations request another step; the following
                  // no-generation decision step ends the turn. Preserve success
                  // through that clean skip, but never through a later failure.
                  this.childCompleted = true;
                }
              },
            ),
        },
      ],
    });
    if (this.closed) {
      await child.close();
      return;
    }
    this.child = child;
  }
}

export function createMemoryWriterExt(
  options: MemoryWriterExtOptions,
): ExtensionFactory {
  return {
    identifier: 'io.stagewise/memory',
    displayName: 'Memory',
    skillNamespace: LEARNING_SKILL_NAMESPACE,
    create: (deps) => new MemoryWriterExtension(deps, options),
  };
}
