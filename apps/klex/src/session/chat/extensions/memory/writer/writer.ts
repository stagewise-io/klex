import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ToolSet } from 'ai';

import {
  type ActivityHistory,
  activityMessageId,
  activityOrdinal,
} from '@/activity-history';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import {
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  isDataPartOf,
  type ResolvedModel,
  type StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';
import {
  createLearningState,
  importLegacySkills,
  LEARNING_SKILL_NAMESPACE,
} from '@/session/chat/extensions/learning';
import {
  createMemoryLoader,
  ENTITY_PREFIX,
  type MemoryLoader,
} from '@/session/chat/extensions/memory/loading';
import type { MemoryRecall } from '@/session/chat/extensions/memory/recall';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';
import type { SkillRegistry } from '@/skills';

import memoryPrompt from '../system-prompt-part.md';
import {
  createEntityStore,
  type EntityStore,
  knownTags,
  renderKnownTags,
} from './entities';
import { createWriterState, type WriterState } from './state';
import prompt from './system-prompt.md';
import { createWriterTools, entityReadResult, skillReadResult } from './tools';
import { writerView } from './view';

// Enabling memory on an existing bot must not replay its whole history on the user's budget.
const FIRST_RUN_MAX_AGE_MS = 21 * 24 * 60 * 60_000;
const FIRST_RUN_MAX_MESSAGES = 3_000;
// New history per chunk; the fixed prompt and tools dominate smaller chunks.
const CHUNK_CHARACTERS = 60_000;
// Pre-opened memory is a shortcut, not a second history budget.
const OPENED_MEMORY_CHARACTERS = 30_000;
const SKILL_FILE = /^skills\/(.+)\/SKILL\.md$/;

/**
 * Memory currently loaded into the host session: the newest `loadedMemories`
 * map (entities and skills) plus the sections opened via `readMemorySection`.
 */
export function loadedMemoryTargets(history: readonly ExtendedUIMessage[]): {
  entities: Map<string, Set<string>>;
  skills: string[];
} {
  let loaded: Record<string, unknown> | undefined;
  let sections: Record<string, unknown> | undefined;
  for (const message of history)
    for (const part of message.parts) {
      const data = (part as { data?: unknown }).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      if (isDataPartOf('loadedMemories', part))
        loaded = data as Record<string, unknown>;
      else if (isDataPartOf('loadedMemorySections', part))
        sections = data as Record<string, unknown>;
    }
  const entities = new Map<string, Set<string>>();
  const skills: string[] = [];
  for (const filename of Object.keys(loaded ?? {}).sort()) {
    if (filename.startsWith(ENTITY_PREFIX) && filename.endsWith('.md'))
      entities.set(filename.slice(ENTITY_PREFIX.length, -3), new Set());
    else {
      const skill = SKILL_FILE.exec(filename)?.[1];
      if (skill && !skill.includes('/references/')) skills.push(skill);
    }
  }
  for (const key of Object.keys(sections ?? {})) {
    let filename: unknown;
    let section: unknown;
    try {
      [filename, section] = JSON.parse(key) as unknown[];
    } catch {
      continue;
    }
    if (
      typeof filename !== 'string' ||
      typeof section !== 'string' ||
      !filename.startsWith(ENTITY_PREFIX) ||
      !filename.endsWith('.md')
    )
      continue;
    const id = filename.slice(ENTITY_PREFIX.length, -3);
    const opened = entities.get(id) ?? new Set<string>();
    opened.add(section);
    entities.set(id, opened);
  }
  return { entities, skills };
}

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
  recall?: Pick<MemoryRecall, 'attachSource'>;
  skillReader: Pick<
    SkillRegistry,
    'list' | 'get' | 'readReference' | 'addDeletionGuard'
  >;
  legacyLearningDirectory: string;
  /** Default-session opt-in; child writers never inherit automatic loading. */
  loadingSkills?: Pick<
    SkillRegistry,
    'snapshot' | 'readReference' | 'recordRead'
  >;
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
  getSystemPromptPart(): string {
    return memoryPrompt;
  }

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
  private readonly loader: MemoryLoader | undefined;
  private detachRecallSource: (() => void) | undefined;

  readonly dataPartTransformers = {
    availableSkills: () => [],
    activeSkills: () => [],
    loadedMemories: () => [],
    loadedMemorySections: () => [],
    memoryLoadingStatus: () => [],
  };

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: MemoryWriterExtOptions,
  ) {
    this.dataDirectory = deps.getDataDir(true);
    this.state = createWriterState(this.dataDirectory);
    this.entities = createEntityStore(join(this.dataDirectory, 'entities'));
    if (options.loadingSkills) {
      this.loader = createMemoryLoader({
        entities: {
          snapshot: async () => {
            if (!this.ready || this.closed)
              throw new Error('Memory source unavailable');
            return this.entities.snapshot();
          },
        },
        skills: options.loadingSkills,
        logger: deps.logger,
      });
    }
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
    this.detachRecallSource = this.options.recall?.attachSource({
      snapshot: async () => {
        if (!this.ready || this.closed)
          throw new Error('Memory source unavailable');
        return this.entities.snapshot();
      },
      getHistory: () => this.deps.getHistory(),
    });
    this.unsubscribe = this.options.activities.subscribe(() => {
      if (!this.parentActive) this.wake();
    });
    this.wake();
  }

  prepareHistoryAnnotations(
    history: readonly ExtendedUIMessage[],
    model: ResolvedModel,
    signal?: AbortSignal,
  ): Promise<ExtendedUIMessage['parts']> {
    return this.loader?.prepare(history, model, signal) ?? Promise.resolve([]);
  }

  getTools(): ToolSet {
    return this.loader?.tools ?? {};
  }

  onHistoryAnnotationsCommitted(parts: ExtendedUIMessage['parts']): undefined {
    this.loader?.commit(parts);
    return undefined;
  }

  onIdle(
    history: readonly ExtendedUIMessage[],
  ): ExtendedUIMessage['parts'] | undefined {
    return this.loader?.idle(history);
  }

  getCheckpointCarry(): Promise<ExtendedUIMessage['parts']> {
    return this.loader?.carry(this.deps.getHistory()) ?? Promise.resolve([]);
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
    this.detachRecallSource?.();
    this.detachRecallSource = undefined;
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

  /**
   * Fresh writer reads of everything the host session has loaded, in the
   * exact readEntity/readSkill result shape, so the child can edit without
   * re-reading. Read at chunk start, so revisions are current.
   */
  private openedMemory(): string {
    const { entities, skills } = loadedMemoryTargets(this.deps.getHistory());
    const blocks: string[] = [];
    let remaining = OPENED_MEMORY_CHARACTERS;
    let omitted = 0;
    const add = (text: string) => {
      if (text.length > remaining) {
        omitted++;
        return;
      }
      remaining -= text.length;
      blocks.push(text);
    };
    for (const [id, sections] of entities) {
      const entity = this.entities.get(id);
      if (entity) add(entityReadResult(entity, [...sections].sort()));
    }
    for (const id of skills) {
      const skill = this.options.skillReader.get(id);
      if (skill) add(skillReadResult(skill));
    }
    if (omitted)
      blocks.push(
        `${omitted} more loaded entries omitted for size; read them if needed.`,
      );
    return blocks.join('\n\n');
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
        // Static for this session: defaults plus every tag in use right now.
        const tagSnapshot = renderKnownTags(knownTags(this.entities.list()));
        const opened = this.openedMemory();
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
                  text: `${selfName ? `<self name="${selfName}"/>\n\n` : ''}<known-tags>\n${tagSnapshot}\n</known-tags>\n\n${opened ? `<opened-memory>\n${opened}\n</opened-memory>\n\n` : ''}<previous-activities>\n${previousText}\n</previous-activities>\n\n<new-activities date="${date}">\n${newText}\n</new-activities>`,
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
