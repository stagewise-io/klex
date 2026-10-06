import './work.css';

import { AnimatePresence } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { jeffScene } from './jeff';
import { jonathanScene } from './jonathan';
import { kristineScene } from './kristine';
import { monicaScene } from './monica';
import type { WorkScene } from './scenes';
import { WorkWindow } from './window';

const scenes: Record<string, WorkScene> = {
  jonathan: jonathanScene,
  kristine: kristineScene,
  monica: monicaScene,
  jeff: jeffScene,
};

type Job = { id: number; bot: string; variant: number };

function Work({
  job,
  bot,
  onDone,
}: {
  job: Job;
  bot: () => HTMLElement | null | undefined;
  onDone: () => void;
}) {
  const { app, Scene } = scenes[job.bot];
  const [current, setCurrent] = useState(() => app(job.variant));
  return (
    <WorkWindow bot={bot} app={current}>
      <Scene variant={job.variant} setApp={setCurrent} onDone={onDone} />
    </WorkWindow>
  );
}

export type WorkState = 'working' | 'done' | 'stopped';

/**
 * The bots take turns: each opens an app window behind it and does a bit
 * of work in it, then the next bot in line starts. The first turn starts as
 * soon as the team arrives. Profiles do not interrupt the rotation;
 * moving a bot stops its demo.
 */
export function HeroWork({
  team,
  order,
  ready,
  busy,
  active,
  onWork,
}: {
  team: () => HTMLElement | null;
  /** Bot ids in the order they take turns. */
  order: readonly string[];
  /** The team has arrived and can start using its apps. */
  ready: boolean;
  /** Moving bots skip their turn and stop working. */
  busy: readonly string[];
  /** False pauses work while the hero is offscreen. */
  active: boolean;
  onWork: (bot: string, state: WorkState) => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [closing, setClosing] = useState(false);
  const turn = useRef(0);
  const variants = useRef<Record<string, number>>({});
  const count = useRef(0);
  /** The last job that has ended, so late callbacks cannot end it twice. */
  const ended = useRef(0);

  const end = (current: Job, state: WorkState) => {
    if (ended.current === current.id) return;
    ended.current = current.id;
    setClosing(true);
    onWork(current.bot, state);
  };

  useEffect(() => {
    if (!active || job || !ready || order.length === 0) return;
    let bot = order[turn.current];
    for (let skipped = 0; busy.includes(bot); skipped++) {
      if (skipped === order.length) return;
      turn.current = (turn.current + 1) % order.length;
      bot = order[turn.current];
    }
    const timer = window.setTimeout(
      () => {
        turn.current = (turn.current + 1) % order.length;
        const previous = variants.current[bot];
        const variant =
          previous === undefined
            ? Math.floor(Math.random() * scenes[bot].count)
            : (previous + 1) % scenes[bot].count;
        variants.current[bot] = variant;
        count.current += 1;
        setClosing(false);
        setJob({ id: count.current, bot, variant });
        onWork(bot, 'working');
      },
      count.current === 0 ? 300 : 500,
    );
    return () => window.clearTimeout(timer);
  }, [active, job, ready, busy, onWork, order]);

  // Stop work when a bot moves or the hero leaves view.
  useEffect(() => {
    if (job && !closing && (!active || busy.includes(job.bot)))
      end(job, 'stopped');
  });

  return (
    <div className="new-work-layer">
      <AnimatePresence onExitComplete={() => setJob(null)}>
        {job && !closing && (
          <Work
            key={job.id}
            job={job}
            bot={() =>
              team()?.querySelector<HTMLElement>(`[data-bot="${job.bot}"]`)
            }
            onDone={() => end(job, 'done')}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
