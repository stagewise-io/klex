import { join } from 'node:path';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { DEFAULT_SESSION_ID } from '@/session/types';
import type { SkillNamespaceHandle } from '@/skills';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';
import { LEARNING_SKILL_NAMESPACE } from './learning-config';
import { createLearningState, type LearningState } from './learning-state';
import { createLearningWorker, type LearningWorker } from './learning-worker';
import { importLegacySkills } from './legacy-skill-import';

export const LEARNING_EXTENSION_ID = 'io.stagewise/learning';

export interface LearningExtOptions {
  episodes: EpisodeFeed;
  /** Reads the current observed agent's soul; storage remains owned by soul. */
  getSoul: () => string | null;
}

class LearningExtension implements Extension {
  private worker: LearningWorker | null = null;
  private release: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: LearningExtOptions,
    private readonly state: LearningState,
    private readonly claimWorker: () => (() => void) | null,
  ) {}

  async onStart(): Promise<void> {
    const release = this.claimWorker();
    if (!release) return;
    this.release = release;
    const skills = this.requireSkills();
    await this.state.start();
    if (this.closed) return;
    const dataDirectory = this.deps.getDataDir(true);
    await importLegacySkills({
      legacyRoot: join(dataDirectory, 'skills'),
      skills,
      state: this.state,
      logger: this.deps.logging.child({
        name: 'learning-skill-import',
        bindings: { module: 'learning-skill-import' },
      }),
    });
    if (this.closed) return;
    const worker = createLearningWorker({
      episodes: this.options.episodes,
      skills,
      state: this.state,
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
    this.worker = worker;
    worker.start();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    await worker?.close();
    this.release?.();
    this.release = null;
  }

  introspect(): Record<string, unknown> {
    return this.worker?.introspect() ?? { worker: 'not owned by this session' };
  }

  private requireSkills(): SkillNamespaceHandle {
    const { skills } = this.deps;
    if (!skills) {
      throw new Error(
        `${LEARNING_EXTENSION_ID} requires the skill registry handle`,
      );
    }
    return skills;
  }
}

class LearningExtensionFactory implements ExtensionFactory {
  readonly identifier = LEARNING_EXTENSION_ID;
  readonly displayName = 'Learning';
  readonly skillNamespace = LEARNING_SKILL_NAMESPACE;
  private readonly states = new Map<string, LearningState>();
  private readonly claimedWorkers = new Set<string>();

  constructor(private readonly options: LearningExtOptions) {}

  create = (deps: ExtensionDeps): Extension => {
    const dataDirectory = deps.getDataDir(true);
    let state = this.states.get(dataDirectory);
    if (!state) {
      state = createLearningState(dataDirectory);
      this.states.set(dataDirectory, state);
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
    return new LearningExtension(deps, this.options, state, claimWorker);
  };
}

/**
 * Learns skills from finished memory episodes in the background and writes
 * them to the `learning` skill namespace. The default-session instance
 * imports pre-registry skills once before its worker starts.
 */
export function createLearningExt(
  options: LearningExtOptions,
): ExtensionFactory {
  return new LearningExtensionFactory(options);
}
