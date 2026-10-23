import './mascot.css';

import { getKlexEyeColor, roundedPath } from '../new/klex/geometry';
import type { BodyShape } from '../new/klex/presets';
import { FAMILY_SHAPES, type MascotForm } from './presets';

export function mascotMarkup(
  color = '#ffbd91',
  form: MascotForm | BodyShape = 'classic',
) {
  const shape = typeof form === 'string' ? FAMILY_SHAPES[form] : form;
  const bodyColor = color
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<svg class="klex-mascot" viewBox="0 0 160 140" role="img" aria-label="Klex Bot" focusable="false">
    <title>Klex Bot</title>
    <ellipse cx="80" cy="129" rx="51" ry="3" fill="currentColor" opacity="0.12" />
    <path d="${roundedPath(shape.outline)}" fill="${bodyColor}" />
    <g transform="translate(${80 + shape.eyeX} ${shape.eyeY})" fill="${getKlexEyeColor(color)}">
      <ellipse data-pupil cx="-9" rx="4.5" ry="6.5" />
      <ellipse data-pupil cx="9" rx="4.5" ry="6.5" />
    </g>
  </svg>`;
}
