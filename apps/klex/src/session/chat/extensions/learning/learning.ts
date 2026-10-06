import { join } from 'node:path';

import type { ToolSet } from 'ai';
import z from 'zod';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { DEFAULT_SESSION_ID } from '@/session/types';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';
import { createLearningState, type LearningState } from './learning-state';
import { createLearningWorker, type LearningWorker } from './learning-worker';
import { renderSkillList } from './prompts';
import {
  createSkillStore,
  type SkillCatalogHub,
  type SkillStore,
  type SkillUsage,
} from './skill-store';

export const LEARNING_EXTENSION_ID = 'io.stagewise/learning';

export interface LearningExtOptions {
  episodes: EpisodeFeed;
  skillCatalog: SkillCatalogHub;
}

interface SharedLearningData {
  store: SkillStore;
  state: LearningState;
}

class LearningExtension implements Extension {
  private worker: LearningWorker | null = null;
  private detachCatalog: (() => void) | null = null;
  private skillList = '';
  private closed = false;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: LearningExtOptions,
    private readonly data: SharedLearningData,
    private readonly claimWorker: () => (() => void) | null,
  ) {}

  async onStart(): Promise<void> {
    await Promise.all([this.data.store.start(), this.data.state.start()]);
    if (this.closed) return;
    const release = this.claimWorker();
    if (release) {
      const worker = createLearningWorker({
        episodes: this.options.episodes,
        store: this.data.store,
        state: this.data.state,
        generateText: this.deps.generateText,
        getModels: () => {
          const memory = this.deps.config.getModelSelection('memory');
          return memory.length > 0
            ? memory
            : this.deps.config.getModelSelection('chat');
        },
        logger: this.deps.logging.child({
          name: 'learning-worker',
          bindings: { module: 'learning-worker' },
        }),
      });
      const detach = this.options.skillCatalog.attach({
        store: this.data.store,
        getUsage: (name) => this.getUsage(name),
      });
      this.worker = worker;
      this.detachCatalog = () => {
        detach();
        release();
      };
      worker.start();
    }
    this.refreshSkillList();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    await worker?.close();
    this.detachCatalog?.();
    this.detachCatalog = null;
  }

  onStepStart(): void {
    this.refreshSkillList();
  }

  getSystemPromptPart(): string {
    return this.skillList;
  }

  getTools(): ToolSet {
    return {
      readSkill: {
        description:
          'Load a learned skill by name before doing a task that matches its description.',
        inputSchema: z.object({
          name: z.string().trim().min(1).describe('Skill name from the list.'),
        }),
        execute: async ({ name }: { name: string }) => this.readSkill(name),
      },
    };
  }

  introspect(): Record<string, unknown> {
    return {
      ...(this.worker?.introspect() ?? { worker: 'not owned by this session' }),
      skillNames: this.data.store.list().map((skill) => skill.name),
    };
  }

  private readSkill(name: string): string {
    const content = this.data.store.read(name);
    if (content === null) {
      const available = this.data.store.list().map((skill) => skill.name);
      return `Unknown skill "${name}". Available: ${available.join(', ') || '(none)'}`;
    }
    const at = new Date().toISOString();
    void this.data.state
      .update((draft) => {
        // Skills without state (restored folders, lost state) start tracking now.
        const entry = draft.skills[name] ?? {
          createdAt: at,
          updatedAt: at,
          lastReadAt: null,
          readCount: 0,
          sourceEpisodes: [],
        };
        draft.skills[name] = entry;
        entry.lastReadAt = at;
        entry.readCount += 1;
        entry.lastReadEpisode = draft.processedEpisodeCount;
      })
      .catch((error: unknown) =>
        this.deps.logger.debug(
          { skill: name, error },
          'Recording skill read failed',
        ),
      );
    return content;
  }

  private getUsage(name: string): SkillUsage | null {
    const entry = this.data.state.get().skills[name];
    if (!entry) return null;
    return {
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastReadAt: entry.lastReadAt,
      readCount: entry.readCount,
      sourceEpisodes: [...entry.sourceEpisodes],
    };
  }

  private refreshSkillList(): void {
    this.skillList = renderSkillList(
      this.data.store.list(),
      this.data.state.get().skills,
    );
  }
}

class LearningExtensionFactory implements ExtensionFactory {
  readonly identifier = LEARNING_EXTENSION_ID;
  readonly displayName = 'Learning';
  private readonly shared = new Map<string, SharedLearningData>();
  private readonly claimedWorkers = new Set<string>();

  constructor(private readonly options: LearningExtOptions) {}

  create = (deps: ExtensionDeps): Extension => {
    const dataDirectory = deps.getDataDir(true);
    let data = this.shared.get(dataDirectory);
    if (!data) {
      data = {
        store: createSkillStore(
          join(dataDirectory, 'skills'),
          deps.logging.child({
            name: 'learning-skill-store',
            bindings: { module: 'learning-skill-store' },
          }),
        ),
        state: createLearningState(dataDirectory),
      };
      this.shared.set(dataDirectory, data);
    }
    const claimWorker = (): (() => void) | null => {
      if (
        deps.sessionId !== DEFAULT_SESSION_ID ||
        this.claimedWorkers.has(dataDirectory)
      ) {
        return null;
      }
      this.claimedWorkers.add(dataDirectory);
      return () => this.claimedWorkers.delete(dataDirectory);
    };
    return new LearningExtension(deps, this.options, data, claimWorker);
  };
}

/**
 * Learns skills from finished memory episodes in the background and exposes
 * them to the session as a system-prompt list plus a `readSkill` tool.
 */
export function createLearningExt(
  options: LearningExtOptions,
): ExtensionFactory {
  return new LearningExtensionFactory(options);
}
