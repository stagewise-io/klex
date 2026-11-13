import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

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
import { isMemoryResultMessage } from '@/session/chat/extensions/memory/retrieval/memory-result';
import { escapeXml } from '@/session/chat/utils/escape-xml';
import {
  ACTIVITY_HISTORY_FILTER,
  createHistoryView,
  LINES_FORMAT_PROMPT,
} from '@/session/chat/utils/history-view';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';

import { createEntityStore, type EntityStore } from '../entities';
import prompt from '../system-prompt.md';
import { createWriterState, type WriterState } from '../writer-state';
import { createWriterTools } from '../writer-tools';

const historyView = createHistoryView({
  filter: {
    ...ACTIVITY_HISTORY_FILTER,
    skipMessage: isMemoryResultMessage,
    text: {
      roles: ['user', 'assistant'],
      limit: { max: 500, truncate: 'middle' },
    },
    tools: {
      ...(ACTIVITY_HISTORY_FILTER.tools as Exclude<
        typeof ACTIVITY_HISTORY_FILTER.tools,
        false
      >),
      skip: (name) => name === 'recall' || name === 'readSkill',
    },
  },
  lines: { messageLimit: 4_000, contextLimit: 2_000 },
});
const fitHistory = historyView.fit.bind(historyView);

export interface MemoryWriterExtOptions {
  activities: ActivityHistory;
  legacyLearningDirectory: string;
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
  private retry: ReturnType<typeof setTimeout> | undefined;
  private childCompleted = false;
  private readonly dataDirectory: string;
  private readonly state: WriterState;
  private readonly entities: EntityStore;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: MemoryWriterExtOptions,
  ) {
    // Preserve writer documents and the registered state path across the rename.
    this.dataDirectory = join(dirname(deps.getDataDir(true)), 'memory-writer');
    this.state = createWriterState(this.dataDirectory);
    this.entities = createEntityStore(join(this.dataDirectory, 'entities'));
  }

  async onStart(): Promise<void> {
    if (this.ready || this.closed) return;
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
  }

  introspect(): Record<string, unknown> {
    return {
      ready: this.ready,
      state: this.state.get(),
      childSessionId: this.child?.sessionId ?? null,
      dataDirectory: this.dataDirectory,
      entitiesDirectory: join(this.dataDirectory, 'entities'),
      entityCount: this.entities.list().length,
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
          await this.state.update((draft) => {
            // A missing cursor means oldest retained history, never a recent window.
            draft.initialized = true;
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
        60_000,
        true,
        fitHistory,
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
              (await activities.listNeighbors(firstSourceId, 5))
                .filter(
                  (source) =>
                    activities.compareIds(source.id, firstSourceId) < 0,
                )
                .sort((a, b) => activities.compareIds(a.id, b.id))
                .map((source) =>
                  activities.readPage(source.id, {
                    offset: 0,
                    limit: 2_400,
                    maxBytes: 2_000_000,
                    view: fitHistory,
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
        const newText = batch.text.replace(
          /^Source (history:[A-Za-z0-9_-]+) \([^\n]*\)\n/gm,
          (_header, id: string) => `[${activityMessageId(id)}]\n`,
        );
        this.abort = new AbortController();
        this.tools = createWriterTools({
          entities: this.entities,
          skills,
          activities,
          signal: this.abort.signal,
          view: fitHistory,
          sourceIds,
        }).tools;
        await this.ensureChild();
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
                text: `<previous-activities>\n${escapeXml(previousText)}\n</previous-activities>\n\n<new-activities>\n${escapeXml(newText)}\n</new-activities>`,
              },
            ],
          },
          SessionInboxUrgency.Default,
        );
        while (!this.closed) {
          if (child.getSessionInfo().status === 'terminated') {
            this.child = undefined;
            throw new Error('Memory writer session terminated');
          }
          if (await child.waitForIdle(1_000)) {
            if (child.getSessionInfo().status === 'terminated') {
              this.child = undefined;
              throw new Error('Memory writer terminated before settling');
            }
            if (!this.childCompleted)
              throw new Error('Memory writer did not complete successfully');
            break;
          }
        }
        if (this.closed) return;
        this.abort.abort();
        this.tools = {};
      }
      await this.state.update((draft) => {
        draft.cursor = batch.id;
      });
    }
  }

  private async ensureChild(): Promise<void> {
    if (this.child) return;
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
                this.childCompleted = Boolean(
                  event.generation &&
                    !event.shouldContinue &&
                    !event.forceNextStep &&
                    !event.generationFailed &&
                    !event.fatalError &&
                    !event.requestRejected &&
                    !event.modelFallbackOccurred &&
                    !event.instinctAborted,
                );
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
