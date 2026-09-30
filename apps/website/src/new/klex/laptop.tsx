import { roundedPath } from '../../mascot/geometry';
import { BODY_SHAPES, type BodyShape } from './presets';

const logoShape = BODY_SHAPES[0];
const logoPath = roundedPath(logoShape.outline);

export function KlexLaptop({ shape }: { shape: BodyShape }) {
  const top = Math.max(76, shape.eyeY + 20);
  const scale = Math.max(22, 120 - top) / 56;

  return (
    <g transform={`translate(${98 + shape.eyeX * 0.4} ${top}) scale(${scale})`}>
      <g transform="matrix(1 0 -0.13 1 6 0)">
        <g transform="matrix(1 0 1.25 1 -56 40)">
          <rect width="72" height="16" rx="4" ry="1.25" fill="#929aa9" />
          <g fill="#667184" opacity="0.8">
            <rect x="3.3" y="6.5" width="3.2" height="1.05" rx="0.25" />
            <rect x="7.1" y="6.5" width="3.2" height="1.05" rx="0.25" />
            <rect x="3.3" y="7.95" width="6.5" height="1.05" rx="0.25" />
            <rect x="3.3" y="9.4" width="5" height="1.05" rx="0.25" />
            <rect x="3.3" y="10.85" width="4.2" height="1.05" rx="0.25" />
          </g>
        </g>
        <rect x="-40" width="80" height="56" rx="4" fill="#727b8d" />
        <g transform="translate(-11.2 17.8) scale(0.14)">
          <path d={logoPath} fill="#c7cdd7" />
          {[-9, 9].map((offset) => (
            <ellipse
              key={offset}
              cx={80 + logoShape.eyeX + offset}
              cy={logoShape.eyeY}
              rx="4.5"
              ry="6.5"
              fill="#727b8d"
            />
          ))}
        </g>
      </g>
    </g>
  );
}
