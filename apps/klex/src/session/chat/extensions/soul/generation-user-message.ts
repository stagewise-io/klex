export interface SoulGenerationInput {
  operation: 'create' | 'update' | 'optimize';
  instructions: string;
  existingSoul: string | null;
}

/**
 * Edit this formatter to change the one-shot soul call's user message.
 * The companion generation-prompt*.md files define its system prompt.
 * Creation must not include the old soul; updates and optimization include it.
 */
export function formatSoulGenerationUserMessage({
  operation,
  instructions,
  existingSoul,
}: SoulGenerationInput): string {
  return JSON.stringify({
    operation,
    ...(operation !== 'create' &&
      existingSoul !== null && {
        existing_soul_description: existingSoul,
      }),
    user_request: instructions,
  });
}
