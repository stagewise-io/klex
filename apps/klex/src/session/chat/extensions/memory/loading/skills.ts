import { randomUUID } from 'node:crypto';

import type { ModuleLogger } from '@stagewise/logger';

import {
  createDataPart,
  isDataPartOf,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { Skill, SkillRegistry } from '@/skills';

import { lexical, type SnapshotMap } from './types';

export type LoadingSkills = Pick<SkillRegistry, 'snapshot'> &
  Partial<Pick<SkillRegistry, 'readReference' | 'recordRead'>>;
export interface SkillSubscriptions {
  version: 1;
  window?: string;
  skills: Record<string, string[]>;
  consumed?: Record<string, string>;
}
export interface SkillContext {
  initialize(history: readonly ExtendedUIMessage[]): void;
  fork(): SkillContext;
  load(skill: string, reference?: string): Promise<Record<string, unknown>>;
  match(id: string, reference?: string): void;
  eligible(messageId: string, projection: string): boolean;
  observe(evidence: readonly { id: string; projection: string }[]): void;
  idle(): void;
  parts(
    skills: readonly Skill[] | undefined,
    window?: string,
  ): ExtendedUIMessage['parts'];
  snapshots(skills: readonly Skill[], window?: string): SnapshotMap;
}
class SkillContextModule implements SkillContext {
  private initialized = false;
  private window: string = randomUUID();
  private readonly active = new Map<string, Set<string>>();
  private evidence: readonly { id: string; projection: string }[] = [];
  private readonly consumed = new Map<string, string>();
  constructor(
    private readonly registry: LoadingSkills,
    private readonly logger: ModuleLogger,
  ) {}
  fork(): SkillContext {
    const copy = new SkillContextModule(this.registry, this.logger);
    copy.initialized = this.initialized;
    copy.window = this.window;
    for (const [id, refs] of this.active) copy.active.set(id, new Set(refs));
    for (const [id, projection] of this.consumed)
      copy.consumed.set(id, projection);
    copy.evidence = this.evidence;
    return copy;
  }
  initialize(history: readonly ExtendedUIMessage[]): void {
    const header = history[0];
    let checkpointWindow: string | undefined;
    if (header?.parts.some((part) => isDataPartOf('context-summary', part))) {
      const carried = header.parts.find((part) =>
        isDataPartOf('activeSkills', part),
      );
      const window = (
        carried as unknown as { data?: SkillSubscriptions } | undefined
      )?.data?.window;
      if (typeof window === 'string') this.window = checkpointWindow = window;
    }
    if (this.initialized) return;
    this.initialized = true;
    for (const message of history)
      for (const part of message.parts) {
        if (!isDataPartOf('activeSkills', part)) continue;
        const data = (part as unknown as { data: SkillSubscriptions }).data;
        if (
          (checkpointWindow !== undefined &&
            data?.window !== checkpointWindow) ||
          data?.version !== 1 ||
          !data.skills ||
          typeof data.skills !== 'object'
        )
          continue;
        if (typeof data.window === 'string') this.window = data.window;
        this.active.clear();
        this.consumed.clear();
        for (const [id, projection] of Object.entries(data.consumed ?? {}))
          if (typeof projection === 'string') this.consumed.set(id, projection);
        for (const [id, refs] of Object.entries(data.skills)) {
          if (
            Array.isArray(refs) &&
            refs.every((ref) => typeof ref === 'string')
          )
            this.active.set(id, new Set(refs));
        }
      }
  }
  async load(id: string, reference?: string): Promise<Record<string, unknown>> {
    const skills = await this.registry.snapshot();
    const skill = skills.find((item) => item.id === id);
    if (!skill)
      return {
        error: 'Unknown skill',
        available: skills.map((item) => item.id),
      };
    if (
      reference !== undefined &&
      (!skill.references?.includes(reference) ||
        this.registry.readReference?.(id, reference) == null)
    ) {
      return { error: 'Unknown reference', available: skill.references ?? [] };
    }
    this.match(id);
    if (reference !== undefined) this.active.get(id)!.add(reference);
    try {
      await this.registry.recordRead?.(id);
    } catch (error) {
      this.logger.debug({ skill: id, error }, 'Recording skill read failed');
    }
    return { loaded: id, ...(reference === undefined ? {} : { reference }) };
  }
  match(id: string, reference?: string): void {
    if (!this.active.has(id)) this.active.set(id, new Set());
    if (reference !== undefined) this.active.get(id)!.add(reference);
  }
  eligible(messageId: string, projection: string): boolean {
    return this.consumed.get(messageId) !== projection;
  }
  observe(evidence: readonly { id: string; projection: string }[]): void {
    this.evidence = evidence;
    const retained = new Set(evidence.map((item) => item.id));
    for (const id of this.consumed.keys())
      if (!retained.has(id)) this.consumed.delete(id);
  }
  idle(): void {
    this.active.clear();
    for (const item of this.evidence)
      this.consumed.set(item.id, item.projection);
  }
  parts(
    skills: readonly Skill[] | undefined,
    window?: string,
  ): ExtendedUIMessage['parts'] {
    if (window !== undefined) this.window = window;
    if (skills !== undefined) {
      const known = new Set(skills.map((skill) => skill.id));
      for (const id of this.active.keys())
        if (!known.has(id)) this.active.delete(id);
    }
    return [
      ...(skills === undefined
        ? []
        : [
            createDataPart(
              'availableSkills',
              skills
                .map((skill) => ({
                  name: skill.id,
                  description: skill.description,
                }))
                .sort((a, b) => lexical(a.name, b.name)),
            ),
          ]),
      createDataPart('activeSkills', {
        version: 1,
        window: window ?? this.window,
        consumed: Object.fromEntries(this.consumed),
        skills: Object.fromEntries(
          [...this.active]
            .sort(([a], [b]) => lexical(a, b))
            .map(([id, refs]) => [id, [...refs].sort(lexical)]),
        ),
      }),
    ] as unknown as ExtendedUIMessage['parts'];
  }
  snapshots(skills: readonly Skill[], window?: string): SnapshotMap {
    const loaded: SnapshotMap = Object.create(null);
    for (const skill of skills) {
      const refs = this.active.get(skill.id);
      if (!refs) continue;
      loaded[`skills/${skill.id}/SKILL.md`] = JSON.stringify({
        version: 1,
        kind: 'skill',
        window: window ?? this.window,
        title: skill.id,
        description: skill.description,
        sections: [],
        body: skill.body,
        references: skill.references ?? [],
      });
      for (const reference of [...refs].sort(lexical)) {
        const body = this.registry.readReference?.(skill.id, reference);
        if (body == null) {
          refs.delete(reference);
          continue;
        }
        loaded[`skills/${skill.id}/references/${reference}.md`] =
          JSON.stringify({
            version: 1,
            kind: 'skill-reference',
            window: window ?? this.window,
            title: skill.id,
            section: reference,
            sections: [],
            body,
          });
      }
    }
    return loaded;
  }
}
export function createSkillContext(
  registry: LoadingSkills,
  logger: ModuleLogger,
): SkillContext {
  return new SkillContextModule(registry, logger);
}
