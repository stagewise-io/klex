import basePrompt from './generation-prompt.md';
import createPrompt from './generation-prompt-create.md';
import optimizePrompt from './generation-prompt-optimize.md';
import updatePrompt from './generation-prompt-update.md';
import type { SoulGenerationInput } from './generation-user-message';

const situationPrompts: Record<SoulGenerationInput['operation'], string> = {
  create: createPrompt,
  update: updatePrompt,
  optimize: optimizePrompt,
};

/** Shared best practices plus exactly one situation-specific prompt part. */
export function getSoulGenerationSystemPrompt(
  operation: SoulGenerationInput['operation'],
): string {
  return [basePrompt, situationPrompts[operation]]
    .map((part) => part.trim())
    .join('\n\n');
}
