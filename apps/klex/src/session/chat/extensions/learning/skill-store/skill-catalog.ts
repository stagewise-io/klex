import type { LearnedSkill } from './skill-format';
import type { SkillStore } from './skill-store';

export type CatalogSkill = LearnedSkill & { origin: 'learned' };

export interface SkillUsage {
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  readCount: number;
  sourceEpisodes: readonly string[];
}

/** Read-only view of the agent's skills, e.g. for the admin API. */
export interface SkillCatalog {
  isAvailable(): boolean;
  list(): readonly CatalogSkill[];
  get(name: string): CatalogSkill | null;
  /** Bookkeeping for a skill; null when unknown or not tracked. */
  getUsage(name: string): SkillUsage | null;
}

export interface SkillCatalogSource {
  store: SkillStore;
  getUsage: (name: string) => SkillUsage | null;
}

export interface SkillCatalogHub extends SkillCatalog {
  /** Attaches the live skill store. Returns a detach function. */
  attach(source: SkillCatalogSource): () => void;
}

class SkillCatalogModule implements SkillCatalogHub {
  private source: SkillCatalogSource | null = null;

  attach(source: SkillCatalogSource): () => void {
    if (this.source) throw new Error('Skill catalog is already attached');
    this.source = source;
    return () => {
      if (this.source === source) this.source = null;
    };
  }

  isAvailable(): boolean {
    return this.source !== null;
  }

  list(): readonly CatalogSkill[] {
    return (this.source?.store.list() ?? []).map((skill) => ({
      ...skill,
      origin: 'learned' as const,
    }));
  }

  get(name: string): CatalogSkill | null {
    const skill = this.source?.store.get(name);
    return skill ? { ...skill, origin: 'learned' } : null;
  }

  getUsage(name: string): SkillUsage | null {
    return this.source?.getUsage(name) ?? null;
  }
}

export function createSkillCatalog(): SkillCatalogHub {
  return new SkillCatalogModule();
}
