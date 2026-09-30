import './extras.css';

import { useAnimate, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { popTransition } from './transitions';

export const EXTRAS = [
  { id: 'none', name: 'None' },
  { id: 'wave', name: 'Wave' },
  { id: 'blush', name: 'Blush' },
  { id: 'tear', name: 'Tear' },
  { id: 'sweat', name: 'Sweat drop' },
  { id: 'sleep', name: 'Zzz' },
  { id: 'question', name: 'Question mark' },
  { id: 'sparkles', name: 'Sparkles' },
  { id: 'steam', name: 'Steam clouds' },
] as const;
export type Extra = (typeof EXTRAS)[number]['id'];

// Coordinates are relative to the shared face anchor, not a particular body.
export function KlexExtras({
  extra = 'none',
  headTop = -36,
  handAnchor,
  paused = false,
  transient = false,
}: {
  extra?: Extra;
  headTop?: number;
  handAnchor: { x: number; y: number };
  paused?: boolean;
  transient?: boolean;
}) {
  return (
    <g data-extra={extra}>
      {extra === 'wave' && (
        <g
          data-wave-anchor
          transform={`translate(${handAnchor.x} ${handAnchor.y})`}
        >
          <WaveHand paused={paused} transient={transient} />
        </g>
      )}
      {extra === 'blush' && (
        <g fill="#ef7b95" opacity="0.7">
          <ellipse cx="-13" cy="11" rx="5" ry="2.7" />
          <ellipse cx="13" cy="11" rx="5" ry="2.7" />
        </g>
      )}
      {extra === 'tear' && (
        <path
          d="M 11 5 C 10 10 5 13 7 17 C 10 23 19 17 15 12 Z"
          fill="#74c8f7"
        />
      )}
      {extra === 'sweat' && (
        <path
          d="M 23 -17 C 21 -10 16 -6 19 -2 C 23 3 30 -2 26 -8 Z"
          fill="#74c8f7"
        />
      )}
      {extra === 'sleep' && (
        <g
          transform={`translate(8 ${headTop})`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <g
            className="klex-sleep-letters"
            style={{ animationPlayState: paused ? 'paused' : 'running' }}
          >
            {[0, 1, 2].map((index) => (
              <g
                key={index}
                className="klex-sleep-letter"
                transform={`translate(${index * 16} ${-index * 20}) scale(${0.7 + index * 0.25})`}
                style={{
                  animationDelay: `${-index * 1.2}s`,
                  animationPlayState: paused ? 'paused' : 'running',
                }}
              >
                <path d="M -6 -6 H 6 L -6 6 H 6" />
              </g>
            ))}
          </g>
        </g>
      )}
      {extra === 'question' && (
        <g
          transform={`translate(0 ${headTop - 4})`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <QuestionMark paused={paused} />
        </g>
      )}
      {extra === 'sparkles' && (
        <g fill="#ffe08b">
          <path
            d={`M -35 ${headTop + 9} l 2 -7 2 7 7 2 -7 2 -2 7 -2 -7 -7 -2 Z`}
          />
          <path
            d={`M 30 ${headTop - 3} l 2 -6 2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 Z`}
          />
          <path d="M 29 9 l 1.5 -4 1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 Z" />
        </g>
      )}
      {extra === 'steam' && (
        <g
          transform={`translate(0 ${headTop})`}
          fill="currentColor"
          opacity="0.65"
        >
          <path d="M -22 5 C -38 6 -40 -4 -33 -6 C -40 -15 -26 -20 -23 -11 C -16 -17 -10 -6 -19 -3 Z" />
          <path d="M 22 5 C 38 6 40 -4 33 -6 C 40 -15 26 -20 23 -11 C 16 -17 10 -6 19 -3 Z" />
        </g>
      )}
    </g>
  );
}

function QuestionMark({ paused }: { paused: boolean }) {
  const [scope, animate] = useAnimate<SVGGElement>();
  const reducedMotion = useReducedMotion();
  const playback = useRef<ReturnType<typeof animate> | null>(null);
  useLayoutEffect(() => {
    const animation = animate(
      scope.current,
      { scale: reducedMotion ? 1 : [0, 1] },
      reducedMotion ? { duration: 0 } : popTransition,
    );
    playback.current = animation;
    return () => {
      animation.stop();
      playback.current = null;
    };
  }, [animate, scope, reducedMotion]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reapply pause when reduced motion replaces playback.
  useEffect(() => {
    if (paused) playback.current?.pause();
    else playback.current?.play();
  }, [paused, reducedMotion]);
  return (
    <g ref={scope} style={{ transformOrigin: '1px 6px' }}>
      <path d="M -4 -6 C -4 -14 7 -14 7 -7 C 7 -3 1 -3 1 1" />
      <path d="M 1 6 V 6.1" />
    </g>
  );
}

function WaveHand({
  paused,
  transient,
}: {
  paused: boolean;
  transient: boolean;
}) {
  const [scope, animate] = useAnimate<SVGGElement>();
  const reducedMotion = useReducedMotion();
  const playback = useRef<ReturnType<typeof animate> | null>(null);
  useLayoutEffect(() => {
    const animation = animate([
      [
        scope.current,
        { scale: reducedMotion ? 1 : [0, 1] },
        reducedMotion ? { duration: 0 } : popTransition,
      ],
      [
        scope.current,
        { rotate: reducedMotion ? 0 : [0, 0, 20, -16, 20, -12, 0, 0] },
        { at: 0, duration: reducedMotion ? 0 : 2.2 },
      ],
      [
        scope.current,
        { scale: transient && !reducedMotion ? 0 : 1 },
        {
          at: reducedMotion ? 0 : 2.08,
          duration: reducedMotion ? 0 : 0.12,
          ease: 'easeIn',
        },
      ],
    ]);
    playback.current = animation;
    return () => {
      animation.stop();
      playback.current = null;
    };
  }, [animate, scope, reducedMotion, transient]);
  // Reapply pause state when the animation above is recreated.
  // biome-ignore lint/correctness/useExhaustiveDependencies: These dependencies replace the playback instance.
  useEffect(() => {
    if (paused) playback.current?.pause();
    else playback.current?.play();
  }, [paused, reducedMotion, transient]);
  return (
    <g ref={scope} style={{ transformOrigin: '0px 8px' }}>
      <text
        x="-15"
        y="8"
        transform="scale(-1 1)"
        fontSize="30"
        style={{
          fontFamily:
            'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif',
        }}
      >
        👋
      </text>
    </g>
  );
}
