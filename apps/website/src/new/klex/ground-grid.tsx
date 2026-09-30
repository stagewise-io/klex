import { useId } from 'react';

export function KlexGroundGrid({
  fadeStart,
  solidStart,
  floor = false,
}: {
  /** Leave both fade values out to mask the grid from outside. */
  fadeStart?: number;
  solidStart?: number;
  /**
   * Draw square tiles for a plane that is tilted back by 60deg, which halves
   * its height and turns the squares into the same 2:1 diamonds.
   */
  floor?: boolean;
}) {
  const patternId = useId();
  const height = floor ? 32 : 16;

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full bg-foreground/[0.025] text-foreground/15"
      style={
        fadeStart === undefined || solidStart === undefined
          ? undefined
          : {
              maskImage: `linear-gradient(to bottom, transparent ${fadeStart * 100}%, black ${solidStart * 100}%)`,
            }
      }
    >
      <defs>
        <pattern
          id={patternId}
          width="32"
          height={height}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M0 ${height / 2} 16 0 32 ${height / 2} 16 ${height}Z`}
            fill="none"
            stroke="currentColor"
            // The tilt thins the diagonals, so start thicker to end at 0.75.
            strokeWidth={floor ? 1.2 : 0.75}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}
