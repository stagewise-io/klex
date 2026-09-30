import { useId } from 'react';

export const EXPRESSIONS = [
  { id: 'neutral', name: 'Neutral' },
  { id: 'happy', name: 'Happy' },
  { id: 'angry', name: 'Angry' },
  { id: 'skeptical', name: 'Skeptical' },
  { id: 'annoyed', name: 'Annoyed' },
  { id: 'sad', name: 'Sad' },
  { id: 'pained', name: 'Pained' },
  { id: 'sleepy', name: 'Sleepy' },
  { id: 'surprised', name: 'Surprised' },
  { id: 'focused', name: 'Focused' },
  { id: 'unsure', name: 'Unsure' },
  { id: 'embarrassed', name: 'Embarrassed' },
  { id: 'suspicious', name: 'Suspicious' },
  { id: 'hearts', name: 'Heart eyes' },
  { id: 'stars', name: 'Star eyes' },
  { id: 'spirals', name: 'Spiral eyes' },
  { id: 'x-eyes', name: 'X eyes' },
] as const;
export type Expression = (typeof EXPRESSIONS)[number]['id'];

function eyeShape(expression: Expression) {
  switch (expression) {
    case 'hearts':
      return <path d="M 0 5.5 C -13 -2 -3 -10 0 -4 C 3 -10 13 -2 0 5.5 Z" />;
    case 'stars':
      return (
        <path d="M 0 -7 2 -2 7 -2 3 1 4.5 6 0 3 -4.5 6 -3 1 -7 -2 -2 -2 Z" />
      );
    case 'spirals':
      return (
        <path
          d="M 0 0 C -2 -2 -3 2 0 3 C 5 4 6 -4 1 -5 C -5 -7 -8 2 -4 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      );
    case 'pained':
      return (
        <path
          d="M -4 -3 2 0 -4 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'x-eyes':
      return (
        <path
          d="M -4 -4 4 4 M 4 -4 -4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      );
    default:
      return (
        <ellipse
          rx={expression === 'surprised' ? 5.6 : 4.5}
          ry={expression === 'sleepy' ? 4.5 : 6.5}
        />
      );
  }
}

// Masks expose the actual body color. The outer groups stay mounted so the
// shared ticker can blink each eye without triggering React renders.
export function KlexEyes({
  expression = 'neutral',
}: {
  expression?: Expression;
}) {
  const id = useId();
  return (
    <g data-expression={expression}>
      {(['left', 'right'] as const).map((side, index) => {
        const mask = `${id}-${side}`;
        const sign = index === 0 ? 1 : -1;
        const cut =
          expression === 'angry' ||
          expression === 'sad' ||
          expression === 'focused'
            ? -2
            : expression === 'annoyed' || expression === 'suspicious'
              ? -0.5
              : expression === 'sleepy'
                ? 1
                : expression === 'skeptical' && index === 0
                  ? -0.5
                  : expression === 'unsure' && index === 1
                    ? -2
                    : -10;
        const slope =
          (expression === 'angry'
            ? 27
            : expression === 'sad'
              ? -24
              : expression === 'focused'
                ? 12
                : 0) * sign;
        const shiftX =
          expression === 'suspicious'
            ? 1.5
            : expression === 'embarrassed'
              ? -1
              : 0;
        const shiftY = expression === 'embarrassed' ? 1.5 : 0;
        return (
          <g key={side} transform={`translate(${sign * -9} 0)`}>
            <g data-eye={side}>
              <g transform={`translate(${shiftX} ${shiftY})`}>
                <defs>
                  <mask
                    id={mask}
                    maskUnits="userSpaceOnUse"
                    x="-10"
                    y="-10"
                    width="20"
                    height="20"
                  >
                    <rect x="-10" y="-10" width="20" height="20" fill="white" />
                    <rect
                      x="-16"
                      y="-20"
                      width="32"
                      height="20"
                      fill="black"
                      data-eyelid="upper"
                      style={{
                        transform: `translateY(${cut}px) rotate(${slope}deg)`,
                      }}
                      className="transition-transform duration-200 ease-out motion-reduce:transition-none"
                    />
                    <ellipse
                      cy="7.5"
                      rx="6"
                      ry="6.5"
                      fill="black"
                      data-eyelid="happy"
                      style={{
                        transform: `translateY(${expression === 'happy' ? 0 : 15}px)`,
                      }}
                      className="transition-transform duration-200 ease-out motion-reduce:transition-none"
                    />
                  </mask>
                </defs>
                <g
                  mask={`url(#${mask})`}
                  data-eye-shape={expression}
                  transform={
                    expression === 'pained' ? `scale(${sign} 1)` : undefined
                  }
                >
                  {eyeShape(expression)}
                </g>
              </g>
            </g>
            <path
              data-eye-closed={side}
              d="M -4.5 0 H 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity="0"
            />
          </g>
        );
      })}
    </g>
  );
}
