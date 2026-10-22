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
import {
  createLearningState,
  type LearningState,
  type SkillState,
} from './learning-state';
import { createLearningWorker, type LearningWorker } from './learning-worker';
import { renderSkillList } from './prompts';
import {
  createSkillStore,
  isValidSkillName,
  type SkillCatalogHub,
  type SkillStore,
  type SkillUsage,
  SkillValidationError,
  validateSkill,
} from './skill-store';

export const LEARNING_EXTENSION_ID = 'io.stagewise/learning';

export interface LearningExtOptions {
  episodes: EpisodeFeed;
  skillCatalog: SkillCatalogHub;
  /** Reads the current observed agent's soul; storage remains owned by soul. */
  getSoul: () => string | null;
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
        createChildSession: this.deps.createChildSession,
        getAgent: () => ({
          name: this.deps.config.get().officialName,
          soul: this.options.getSoul(),
        }),
        getModelPurpose: () =>
          this.deps.config.getModelSelection('memory').length > 0
            ? 'memory'
            : 'chat',
        logger: this.deps.logging.child({
          name: 'learning-worker',
          bindings: { module: 'learning-worker' },
        }),
      });
      const detach = this.options.skillCatalog.attach({
        store: this.data.store,
        getUsage: (name) => this.getUsage(name),
        update: async (name, patch) => {
          if (!isValidSkillName(name)) return null;
          const existing = this.data.store.get(name);
          if (!existing) return null;
          const next = {
            ...existing,
            description:
              patch.description !== undefined
                ? patch.description.trim()
                : existing.description,
            body: patch.body !== undefined ? patch.body.trim() : existing.body,
          };
          const reason = validateSkill(next);
          if (reason) throw new SkillValidationError(reason);
          const at = new Date().toISOString();
          let previousEntry: SkillState | undefined;
          await this.data.state.update((draft) => {
            previousEntry = Object.hasOwn(draft.skills, name)
              ? structuredClone(draft.skills[name])
              : undefined;
            const entry = (Object.hasOwn(draft.skills, name)
              ? draft.skills[name]
              : undefined) ?? {
              createdAt: at,
              updatedAt: at,
              lastReadAt: null,
              readCount: 0,
              sourceEpisodes: [],
              createdEpisode: draft.processedEpisodeCount,
              lastReadEpisode: null,
            };
            draft.skills[name] = entry;
            entry.updatedAt = at;
            entry.updatedEpisode = draft.processedEpisodeCount;
            entry.userEdited = true;
          });
          try {
            await this.data.store.write(next);
          } catch (error) {
            await this.data.state
              .update((draft) => {
                if (previousEntry) {
                  draft.skills[name] = previousEntry;
                } else {
                  delete draft.skills[name];
                }
              })
              .catch(() => undefined);
            throw error;
          }
          return { ...next, origin: 'learned' as const };
        },
        delete: async (name) => {
          if (!this.data.store.get(name)) return false;
          await this.data.store.delete(name);
          await this.data.state.update((draft) => {
            delete draft.skills[name];
          });
          return true;
        },
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
        const entry = (Object.hasOwn(draft.skills, name)
          ? draft.skills[name]
          : undefined) ?? {
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
    const skills = this.data.state.get().skills;
    const entry = Object.hasOwn(skills, name) ? skills[name] : undefined;
    if (!entry) return null;
    return {
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastReadAt: entry.lastReadAt,
      readCount: entry.readCount,
      sourceEpisodes: [...entry.sourceEpisodes],
      userEdited: entry.userEdited,
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
