import { expect, test } from 'vitest';

import { getKlexEyeColor } from '../new/klex/geometry';
import { mascotMarkup } from './index';
import { FAMILY_SHAPES } from './presets';

test('renders every family form as a finite resting outline with contrasting eyes', () => {
  for (const shape of Object.values(FAMILY_SHAPES)) {
    expect(mascotMarkup('#ffbd91', shape)).not.toMatch(/NaN|Infinity/);
  }
  expect(getKlexEyeColor('#ffbd91')).toBe('#172033');
  expect(getKlexEyeColor('#172033')).toBe('#ffffff');
});
