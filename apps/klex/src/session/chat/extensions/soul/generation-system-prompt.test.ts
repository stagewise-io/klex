import { describe, expect, it } from 'vitest';

import basePrompt from './generation-prompt.md';
import createPrompt from './generation-prompt-create.md';
import optimizePrompt from './generation-prompt-optimize.md';
import updatePrompt from './generation-prompt-update.md';
import { getSoulGenerationSystemPrompt } from './generation-system-prompt';

const parts = {
  create: createPrompt,
  update: updatePrompt,
  optimize: optimizePrompt,
};

describe('Soul generation system prompt', () => {
  it.each(['create', 'update', 'optimize'] as const)(
    'combines the shared base with only the %s part',
    (operation) => {
      const prompt = getSoulGenerationSystemPrompt(operation);
      expect(prompt).toBe(`${basePrompt.trim()}\n\n${parts[operation].trim()}`);
      for (const other of ['create', 'update', 'optimize'] as const) {
        if (other !== operation)
          expect(prompt).not.toContain(parts[other].trim());
      }
    },
  );
});
