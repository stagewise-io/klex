import { DEFAULT_SESSION_ID } from '@/session/types';
import type { SkillRegistry } from '@/skills';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
} from '../extension-api';
import systemPromptPart from './system-prompt-part.md';

export const SKILLS_EXTENSION_ID = 'io.stagewise/skills';

class SkillsExtension implements Extension {
  /** True once the current turn produced a successful step. */
  private turnSucceeded = false;

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly registry: SkillRegistry,
  ) {}

  getSystemPromptPart(): string {
    return systemPromptPart;
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

  introspect(): Record<string, unknown> {
    return {
      turn: this.registry.currentTurn(),
      skillIds: this.registry.list().map((skill) => skill.id),
    };
  }
}

/**
 * Contributes skill-use instructions and advances the registry activity clock.
 * The memory loader owns discovery, loadSkill and active skill context.
 */
export function createSkillsExt(registry: SkillRegistry): ExtensionFactory {
  return {
    identifier: SKILLS_EXTENSION_ID,
    displayName: 'Skills',
    create: (deps) => new SkillsExtension(deps, registry),
  };
}
