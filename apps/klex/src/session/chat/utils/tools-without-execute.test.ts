import { describe, expect, it, vi } from 'vitest';
import z from 'zod';

import { toolsWithoutExecute } from './tools-without-execute';

const tools = {
  alpha: {
    description: 'alpha tool',
    inputSchema: z.object({ x: z.string() }),
    outputSchema: z.string(),
    execute: vi.fn().mockResolvedValue('a'),
  },
  beta: {
    description: 'beta tool',
    inputSchema: z.object({ y: z.number() }),
    execute: vi.fn().mockResolvedValue('b'),
  },
};

describe('toolsWithoutExecute', () => {
  it('sets execute to undefined and preserves all other properties', () => {
    const result = toolsWithoutExecute(tools);

    expect(result.alpha.execute).toBeUndefined();
    expect(result.beta.execute).toBeUndefined();
    expect(result.alpha.description).toBe('alpha tool');
    expect(result.alpha.inputSchema).toBe(tools.alpha.inputSchema);
    expect(result.alpha.outputSchema).toBe(tools.alpha.outputSchema);
    expect(result.beta.inputSchema).toBe(tools.beta.inputSchema);
  });

  it('does not mutate the original tools', () => {
    const originalExecute = tools.alpha.execute;
    toolsWithoutExecute(tools);

    expect(tools.alpha.execute).toBe(originalExecute);
  });

  it('returns an empty object for an empty tool set', () => {
    expect(toolsWithoutExecute({})).toEqual({});
  });
});
