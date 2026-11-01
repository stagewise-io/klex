import { describe, expect, it } from 'vitest';

import { formatSoulGenerationUserMessage } from './generation-user-message';

describe('Soul generation user message', () => {
  it('formats creation instructions without an existing soul', () => {
    expect(
      JSON.parse(
        formatSoulGenerationUserMessage({
          operation: 'create',
          instructions: 'Be direct',
          existingSoul: null,
        }),
      ),
    ).toEqual({ operation: 'create', user_request: 'Be direct' });
  });

  it('never includes the old soul when creating from scratch', () => {
    expect(
      JSON.parse(
        formatSoulGenerationUserMessage({
          operation: 'create',
          instructions: 'Start over',
          existingSoul: 'Old identity',
        }),
      ),
    ).toEqual({ operation: 'create', user_request: 'Start over' });
  });

  it('includes the existing soul without new instructions for optimization', () => {
    expect(
      JSON.parse(
        formatSoulGenerationUserMessage({
          operation: 'optimize',
          instructions: '',
          existingSoul: 'Existing identity',
        }),
      ),
    ).toEqual({
      operation: 'optimize',
      existing_soul_description: 'Existing identity',
      user_request: '',
    });
  });

  it('keeps multiline instructions and the full existing soul distinct for updates', () => {
    const instructions = 'Be "direct".\nStay curious.';
    const existingSoul = '# Identity\nCalm, not passive.\nUse \\ when needed.';
    expect(
      JSON.parse(
        formatSoulGenerationUserMessage({
          operation: 'update',
          instructions,
          existingSoul,
        }),
      ),
    ).toEqual({
      operation: 'update',
      existing_soul_description: existingSoul,
      user_request: instructions,
    });
  });
});
