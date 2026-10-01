import './styles.css';

import { stagger, useAnimate } from 'motion/react';
import { useEffect, useRef } from 'react';

import { popTransition } from '../../../../klex/transitions';
import {
  type CardProps,
  FeatureCard,
  type SceneProps,
} from '../../shared/feature-card';
import { SceneBot } from '../../shared/scene-bot';

export function MemoryCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="memory"
      title="Learns how you work"
      description="People, decisions, skills and processes. Your bots’ memory and skills grow and improve with every task."
      Scene={MemoryScene}
      playing={playing}
    />
  );
}

const memories = [
  { text: 'Review before shipping', x: 12, y: 20, tilt: -12 },
  { text: 'Monica → hiring', x: 55, y: 4, tilt: 8 },
  { text: 'Friday team updates', x: 88, y: 24, tilt: 14 },
  { text: 'British English', x: 30, y: 0, tilt: -5 },
  { text: 'Keep views private', x: 72, y: 37, tilt: -16 },
  { text: 'Ask Jeff to test', x: 12, y: 85, tilt: 9 },
  { text: 'Designs in Figma', x: 46, y: 57, tilt: -8 },
  { text: 'No Friday deploys', x: 87, y: 91, tilt: 5 },
  { text: 'Share the PR link', x: 30, y: 73, tilt: 17 },
  { text: 'Keep it simple', x: 67, y: 97, tilt: -11 },
  { text: 'Stand-up at 10', x: 12, y: 145, tilt: -7 },
  { text: 'Customer feedback first', x: 88, y: 150, tilt: 12 },
  { text: 'Write it down', x: 46, y: 115, tilt: 6 },
  { text: 'Use #product', x: 67, y: 17, tilt: -4 },
  { text: 'Dark mode too!', x: 30, y: 135, tilt: -15 },
  { text: 'Check mobile', x: 80, y: 125, tilt: 18 },
  { text: 'Small pull requests', x: 16, y: 52, tilt: -3 },
  { text: 'Accessibility matters', x: 59, y: 68, tilt: 13 },
];

function MemoryScene({ active }: SceneProps) {
  const [wall, animate] = useAnimate<HTMLDivElement>();
  const sequence = useRef<ReturnType<typeof animate> | null>(null);

  useEffect(() => {
    if (!active) {
      sequence.current?.pause();
      return;
    }
    if (sequence.current) {
      sequence.current.play();
      return;
    }
    sequence.current = animate(
      [
        [
          '.bento-memory-paper',
          { scale: [0, 1] },
          { ...popTransition, delay: stagger(0.38), at: 0.6 },
        ],
        [
          '.bento-memory-paper',
          { scale: 0 },
          { duration: 0.18, delay: stagger(0.02), ease: 'easeIn', at: 11.8 },
        ],
      ],
      { repeat: Number.POSITIVE_INFINITY },
    );
  }, [active, animate]);

  useEffect(
    () => () => {
      sequence.current?.stop();
      sequence.current = null;
    },
    [],
  );

  return (
    <div className="bento-memory-scene">
      <div ref={wall} className="bento-memory-wall">
        {memories.map(({ text, x, y, tilt }) => (
          <div
            className="bento-memory-sticky"
            key={text}
            style={{
              left: `calc(${x}% - 26px)`,
              top: y,
              transform: `rotate(${tilt}deg)`,
            }}
          >
            <div className="bento-memory-paper">{text}</div>
          </div>
        ))}
      </div>
      <div className="bento-memory-bot">
        <SceneBot active={active} activity="working" size={100} />
      </div>
    </div>
  );
}
