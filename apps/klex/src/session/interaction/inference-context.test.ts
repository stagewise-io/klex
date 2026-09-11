import { describe, expect, it } from 'vitest';

import { assembleInferenceInstructions } from './inference-context';

describe('assembleInferenceInstructions', () => {
  it('preserves ordered, non-empty instruction contributions', () => {
    expect(
      assembleInferenceInstructions('  base  ', [
        ' extension one ',
        '   ',
        'extension two',
      ]),
    ).toBe('base\n\nextension one\n\nextension two');
  });
});
