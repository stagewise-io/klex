import type { ToolResultPart } from 'ai';

/** Extracts a text string from a ToolResultPart's output field. */
export function extractToolResultText(part: ToolResultPart): string {
  const output = part.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    if (output.type === 'text') return output.value as string;
    if (output.type === 'error-text') return output.value as string;
    if (output.type === 'json') return JSON.stringify(output.value);
    if (output.type === 'content' && Array.isArray(output.value)) {
      return output.value
        .map((p: { type: string; text?: string }) =>
          p.type === 'text' ? p.text : '',
        )
        .join('');
    }
  }
  return '';
}
