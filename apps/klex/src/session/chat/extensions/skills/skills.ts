import type { ToolSet } from 'ai';
import z from 'zod';

import { DEFAULT_SESSION_ID } from '@/session/types';
import type { SkillRegistry } from '@/skills';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
} from '../extension-api';
import { renderSkillList } from './skill-list';

export const SKILLS_EXTENSION_ID = 'io.stagewise/skills';

class SkillsExtension implements Extension {
  private skillList = '';
  /** True once the current turn produced a successful step. */
  private turnSucceeded = false;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly registry: SkillRegistry,
  ) {}

  async onStart(): Promise<void> {
    this.refreshSkillList();
  }

  onStepStart(): void {
    this.refreshSkillList();
  }

  getSystemPromptPart(): string {
    return this.skillList;
  }

  onStepComplete(event: StepCompleteEvent): void {
    if (
      event.generation !== null &&
      !event.generationFailed &&
      !event.fatalError
    ) {
      this.turnSucceeded = true;
    }
    if (event.shouldContinue || event.forceNextStep) return;
    // Only the default session drives the agent activity clock.
    if (this.turnSucceeded && this.deps.sessionId === DEFAULT_SESSION_ID) {
      this.registry.tick();
    }
    this.turnSucceeded = false;
  }

  getTools(): ToolSet {
    return {
      readSkill: {
        description:
          'Load a skill by id before doing a task that matches its description. Pass `reference` to load one of its listed reference files.',
        inputSchema: z.object({
          id: z
            .string()
            .trim()
            .min(1)
            .describe('Skill id from the list, e.g. "namespace/name".'),
          reference: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe('Reference name listed in the skill, without .md.'),
        }),
        execute: async ({
          id,
          reference,
        }: {
          id: string;
          reference?: string;
        }) =>
          reference === undefined
            ? this.readSkill(id)
            : this.readReference(id, reference),
      },
    };
  }

  introspect(): Record<string, unknown> {
    return {
      turn: this.registry.currentTurn(),
      skillIds: this.registry.list().map((skill) => skill.id),
    };
  }

  private readSkill(id: string): string {
    const content = this.registry.read(id);
    if (content === null) return unknownSkill(id, this.registry);
    const references = this.registry.get(id)?.references ?? [];
    this.recordRead(id);
    return references.length
      ? `${content}\n\n---\nReference files (load with readSkill id + reference when needed): ${references.join(', ')}`
      : content;
  }

  private readReference(id: string, reference: string): string {
    const skill = this.registry.get(id);
    if (!skill) return unknownSkill(id, this.registry);
    const content = this.registry.readReference(id, reference);
    if (content === null)
      return `Unknown reference "${reference}" of "${id}". Available: ${skill.references.join(', ') || '(none)'}`;
    return content;
  }

  private recordRead(id: string): void {
    void this.registry
      .recordRead(id)
      .catch((error: unknown) =>
        this.deps.logger.debug(
          { skill: id, error },
          'Recording skill read failed',
        ),
      );
  }

  private refreshSkillList(): void {
    this.skillList = renderSkillList(this.registry.list());
  }
}

/** Error text listing available ids; ids sharing the input's bare name first. */
function unknownSkill(id: string, registry: SkillRegistry): string {
  const bareName = id.slice(id.lastIndexOf('/') + 1);
  const matching = registry.resolveName(bareName).map((skill) => skill.id);
  const rest = registry
    .list()
    .map((skill) => skill.id)
    .filter((candidate) => !matching.includes(candidate));
  const available = [...matching, ...rest];
  return `Unknown skill "${id}". Available: ${available.join(', ') || '(none)'}`;
}

/**
 * Exposes all agent-wide skills to a session: a fair-share system-prompt
 * list and a `readSkill` tool that records reads. Also advances the
 * registry's activity clock once per successful default-session turn.
 */
export function createSkillsExt(registry: SkillRegistry): ExtensionFactory {
  return {
    identifier: SKILLS_EXTENSION_ID,
    displayName: 'Skills',
    create: (deps) => new SkillsExtension(deps, registry),
  };
}
