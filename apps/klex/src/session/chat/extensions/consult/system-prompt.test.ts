import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const childPrompt = readFileSync(
  new URL('./consult-system-prompt.md', import.meta.url),
  'utf8',
);
const parentPrompt = readFileSync(
  new URL('./main-system-prompt.md', import.meta.url),
  'utf8',
);

describe('consult system prompt contracts', () => {
  it('documents the exact parent state and report blocks', () => {
    expect(parentPrompt).toMatch(/<consults full>/);
    expect(parentPrompt).toMatch(/<consults change>/);
    expect(parentPrompt).toMatch(
      /<consult-report\s+handle=\.\.\.\s+\[final\]>/i,
    );
    expect(parentPrompt).toMatch(/final/i);
    expect(parentPrompt).not.toMatch(/status=/i);
  });

  it('documents the exact child context and report blocks', () => {
    expect(childPrompt).toMatch(/<message-from-main>/);
    expect(childPrompt).toMatch(/<main-session-context>/);
    expect(childPrompt).toMatch(/report/i);
    expect(childPrompt).toMatch(/final/i);
    expect(childPrompt).toMatch(/complete/i);
  });
});
