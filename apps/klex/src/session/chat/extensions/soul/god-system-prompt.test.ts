import { describe, expect, it } from 'vitest';

import basePrompt from './generation-prompt.md';
import createPrompt from './generation-prompt-create.md';
import optimizePrompt from './generation-prompt-optimize.md';
import updatePrompt from './generation-prompt-update.md';
import { getSoulGodSystemPrompt } from './god-system-prompt';
import managementPrompt from './system-prompt-part/god-soul-management.md';
import noSoulPrompt from './system-prompt-part/no-soul-god.md';
import { getSystemPromptPart } from './system-prompt-part/with-soul';

describe('God-session soul prompt', () => {
  it.each([null, 'You are calm and precise.'])(
    'reuses the current writing parts with soul %j',
    (soul) => {
      const prompt = getSoulGodSystemPrompt(soul);
      expect(prompt).toBe(
        [
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
          .join('\n\n'),
      );
    },
  );

  it('scopes writing to authorization and adapts the API output contract to the tool', () => {
    expect(managementPrompt).toContain(
      'only when an explicit god message requests it',
    );
    expect(managementPrompt).toContain('Select exactly one operation');
    expect(managementPrompt).toContain('`user_request`');
    expect(managementPrompt).toContain('`existing_soul_description`');
    expect(managementPrompt).toContain(
      'Follow Operation: Refine with an empty',
    );
    expect(managementPrompt).toContain('Ignore the old soul');
    expect(managementPrompt).toContain('`content` argument of `updateSoul`');
    expect(managementPrompt).toContain(
      'Do not claim the soul was saved until the\ntool succeeds',
    );
  });
});
