import './linear.css';

import { motion, useReducedMotion } from 'motion/react';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SceneProgress } from '../workflow/controls';
import {
  PopBot,
  type PopBotHandle,
  usePlay,
  useStepPlayback,
  WalkingBot,
  type WalkingBotHandle,
  wait,
} from '../workflow/stage';
import { LinearIssueDialog } from './dialog';

export { LinearIssueDialog };

export const careersIssue = {
  title: 'Publish a Product Designer role',
  description:
    "Build a careers page with Monica's job description and an application form. Accept a résumé upload and send each application to Monica.",
};

export async function typeIssueText(
  text: string,
  write: (value: string) => void,
  signal: AbortSignal,
  duration: number,
) {
  signal.throwIfAborted();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    write(text);
    return;
  }
  const delays = Array.from(text, (_, index) => {
    const previous = text[index - 1] ?? '';
    if (/[.!?,]/.test(previous)) return 8 + Math.random() * 5;
    if (previous === ' ') return 2 + Math.random() * 3;
    return 0.5 + Math.random();
  });
  const pace = duration / delays.reduce((sum, delay) => sum + delay, 0);
  let next = performance.now();
  for (let index = 0; index < text.length; index++) {
    next += delays[index] * pace;
    await wait(Math.max(0, next - performance.now()), signal);
    write(text.slice(0, index + 1));
  }
}

export const linearMarkup = `
      <section class="new-linear-story" aria-labelledby="new-linear-story-title">
        <div id="linear-issue-story"></div>
      </section>
`;

function LinearScene({
  playing,
  finished,
  skipArrival,
  onComplete,
}: {
  playing: boolean;
  finished: boolean;
  skipArrival: boolean;
  onComplete: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const monica = useRef<WalkingBotHandle>(null);
  const kristine = useRef<WalkingBotHandle>(null);
  const jonathan = useRef<PopBotHandle>(null);
  const [open, setOpen] = useState(finished);
  const [title, setTitle] = useState(finished ? careersIssue.title : '');
  const [description, setDescription] = useState(
    finished ? careersIssue.description : '',
  );
  const [assignee, setAssignee] = useState<string | undefined>(
    finished ? 'Jonathan' : undefined,
  );
  const [createdAs, setCreatedAs] = useState<string | undefined>(
    finished ? 'PRO-42' : undefined,
  );
  const [progress, setProgress] = useState(finished ? 1 : 0);

  usePlay(
    playing,
    async (signal) => {
      setProgress(0.03);
      await monica.current?.walkTo(
        { edge: 'center', offset: -0.7, vertical: 'center' },
        signal,
        skipArrival,
      );
      monica.current?.say(
        'We’re hiring a Product Designer. Build a careers page with an application form and send every application to me.',
      );
      setProgress(0.25);
      await wait(3200, signal);
      monica.current?.say(null);
      kristine.current?.emote('happy-nod');
      kristine.current?.say('Got it. I’ll plan it for Jonathan.');
      await wait(2200, signal);
      kristine.current?.say(null);

      setProgress(0.45);
      setOpen(true);
      await Promise.all([
        monica.current?.walkTo('slack-home', signal),
        (async () => {
          await kristine.current?.walkTo({ edge: 'center' }, signal);
          kristine.current?.setActivity('working');
          await wait(400, signal);
          await typeIssueText(
            careersIssue.title,
            (value) => {
              setTitle(value);
              setProgress(
                0.45 + (0.1 * value.length) / careersIssue.title.length,
              );
            },
            signal,
            650,
          );
          await wait(300, signal);
          await typeIssueText(
            careersIssue.description,
            (value) => {
              setDescription(value);
              setProgress(
                0.55 + (0.2 * value.length) / careersIssue.description.length,
              );
            },
            signal,
            1400,
          );
          await wait(400, signal);
          setAssignee('Jonathan');
          await wait(700, signal);
          setCreatedAs('PRO-42');
          setProgress(0.85);
          kristine.current?.setActivity('idle');
          kristine.current?.emote('happy-nod');

          await kristine.current?.walkTo(
            { edge: 'center', offset: -0.6 },
            signal,
          );
          await jonathan.current?.show(signal);
          setProgress(0.92);
          await wait(900, signal);
          jonathan.current?.say('PRO-42 is mine. I’ll build it.');
          await wait(2600, signal);
          jonathan.current?.say(null);
        })(),
      ]);
      setProgress(1);
    },
    onComplete,
  );

  return (
    <>
      <div className="new-linear-window" ref={frame}>
        <motion.div
          className="new-linear-popup"
          data-open={open}
          initial={false}
          animate={{ opacity: open ? 1 : 0, scale: open || reduced ? 1 : 0.8 }}
          transition={
            reduced
              ? { duration: 0 }
              : { type: 'spring', visualDuration: 0.4, bounce: 0.25 }
          }
        >
          <p className="new-linear-label">
            <img src="/connectors/linear.svg" alt="" width="22" height="22" />
            Linear
          </p>
          <LinearIssueDialog
            title={title}
            description={description}
            assignee={assignee}
            createdAs={createdAs}
          />
        </motion.div>
        <WalkingBot
          ref={monica}
          bot="monica"
          anchor={frame}
          speech="left"
          start="slack-home"
          settled={finished}
        />
        <WalkingBot
          ref={kristine}
          settled={finished}
          bot="kristine"
          anchor={frame}
          start={
            finished
              ? { edge: 'center', offset: -0.6 }
              : { edge: 'center', offset: 0.7, vertical: 'center' }
          }
        />
        <PopBot
          visible={finished}
          ref={jonathan}
          bot="jonathan"
          className="new-linear-jonathan"
        />
      </div>
      <SceneProgress progress={progress} />
    </>
  );
}

function LinearStory() {
  const { host, run, playing, finished, skipArrival, onComplete } =
    useStepPlayback();
  return (
    <div ref={host}>
      <LinearScene
        key={run}
        playing={playing}
        finished={finished}
        skipArrival={skipArrival}
        onComplete={onComplete}
      />
    </div>
  );
}

export function mountLinear() {
  const host = document.getElementById('linear-issue-story');
  if (!host) throw new Error('The Linear story container is missing.');
  const root = createRoot(host);
  root.render(<LinearStory />);
  return () => root.unmount();
}
