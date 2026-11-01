import basePrompt from './generation-prompt.md';
import createPrompt from './generation-prompt-create.md';
import optimizePrompt from './generation-prompt-optimize.md';
import updatePrompt from './generation-prompt-update.md';
import managementPrompt from './system-prompt-part/god-soul-management.md';
import noSoulPrompt from './system-prompt-part/no-soul-god.md';
import { getSystemPromptPart } from './system-prompt-part/with-soul';

/** Reuse the API's writing standards without applying them to ordinary god turns. */
export function getSoulGodSystemPrompt(soul: string | null): string {
  return [
    soul === null ? noSoulPrompt : getSystemPromptPart(soul),
    managementPrompt,
    '<soul-writing-guidelines>',
    basePrompt,
    createPrompt,
    updatePrompt,
    optimizePrompt,
    '</soul-writing-guidelines>',
  ]
    .map((part) => part.trim())
    .join('\n\n');
}
