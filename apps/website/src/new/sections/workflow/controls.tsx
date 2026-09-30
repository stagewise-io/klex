import './controls.css';

import { animate, motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Button } from '@stagewise/ui/src/components/ui/button.tsx';
import { Progress } from '@stagewise/ui/src/components/ui/progress.tsx';

const PROGRESS = 'new-workflow-progress';

/** Stories publish milestones; controls never unlock before completion. */
export function reportProgress(slide: HTMLElement, progress: number) {
  slide.dataset.progress = String(progress);
  slide.dispatchEvent(new Event(PROGRESS, { bubbles: true }));
}

export function SceneProgress({ progress }: { progress: number }) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const slide = marker.current?.closest<HTMLElement>('.new-workflow-slide');
    if (slide) reportProgress(slide, progress);
  }, [progress]);
  return <span ref={marker} hidden />;
}

// Full playback timings, including travel and typing. Controls wait for both
// the linear fill and the story to finish before starting the Next countdown.
const durations = [13, 27, 25.3, 6.2];

function NextCountdown({ onNext }: { onNext: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onNext, 5000);
    return () => window.clearTimeout(timer);
  }, [onNext]);

  return (
    <svg
      data-icon="inline-start"
      data-autoplay-countdown=""
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="-rotate-90"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="7" opacity="0.25" />
      <motion.circle
        cx="9"
        cy="9"
        r="7"
        pathLength="1"
        strokeDasharray="1"
        strokeLinecap="round"
        initial={{ strokeDashoffset: 1 }}
        animate={{ strokeDashoffset: 0 }}
        transition={{ duration: 5, ease: 'linear' }}
      />
    </svg>
  );
}

function usePlaybackProgress(started: boolean, duration: number) {
  const [value, setValue] = useState(0);
  const completed = useRef(false);
  useEffect(() => {
    if (!started) {
      completed.current = false;
      setValue(0);
      return;
    }
    if (completed.current) return;
    setValue(0);
    const animation = animate(0, 100, {
      duration,
      ease: 'linear',
      onUpdate: setValue,
      onComplete: () => {
        completed.current = true;
      },
    });
    return () => animation.stop();
  }, [started, duration]);
  return value;
}

function Controls({
  progress,
  step,
  last,
  autoplay,
  onPause,
  onReplay,
  onNext,
  onRestart,
}: {
  progress: number;
  step: number;
  last: boolean;
  autoplay: boolean;
  onPause: () => void;
  onReplay: () => void;
  onNext: () => void;
  onRestart: () => void;
}) {
  const reduced = useReducedMotion();
  const nextButton = useRef<HTMLButtonElement>(null);
  const value = usePlaybackProgress(
    progress > 0,
    reduced ? 0 : durations[step],
  );
  const done = progress === 1 && value === 100;
  return (
    <div className="new-workflow-controls">
      <Button
        variant="outline"
        size="icon"
        className="rounded-full"
        aria-label="Replay this step"
        title="Replay this step"
        onClick={onReplay}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 10a9 9 0 1 1 2.5 8M3 4v6h6" />
        </svg>
      </Button>
      <div className="new-workflow-next" data-ready={done}>
        <Progress
          value={value}
          aria-label="Current step progress"
          aria-hidden={done}
          className="new-workflow-progress"
        />
        <Button
          ref={nextButton}
          onClick={last ? onRestart : onNext}
          disabled={!done}
          aria-hidden={!done}
          className="new-workflow-next-button relative rounded-full bg-clip-border transition-none"
        >
          {!last &&
            autoplay &&
            (done ? (
              <NextCountdown onNext={onNext} />
            ) : (
              <svg
                data-icon="inline-start"
                viewBox="0 0 18 18"
                aria-hidden="true"
              />
            ))}
          {last && (
            <svg
              data-icon="inline-start"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 10a9 9 0 1 1 2.5 8M3 4v6h6" />
            </svg>
          )}
          <span>{last ? 'Start over' : 'Next'}</span>
          {!last && (
            <svg
              data-icon="inline-end"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 4v16m-6-6 6 6 6-6" />
            </svg>
          )}
        </Button>
      </div>
      {!last && autoplay && done && (
        <Button
          variant="outline"
          size="icon"
          className="new-workflow-pause-button rounded-full"
          aria-label="Pause autoplay"
          title="Pause autoplay"
          onClick={() => {
            onPause();
            nextButton.current?.focus();
          }}
        >
          <svg
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2.75" y="2.75" width="3.5" height="12.5" rx="1" ry="1" />
            <rect x="11.75" y="2.75" width="3.5" height="12.5" rx="1" ry="1" />
          </svg>
        </Button>
      )}
    </div>
  );
}

export function mountWorkflowControls(
  viewport: HTMLElement,
  slides: HTMLElement[],
  onReplay: () => void,
  onNext: () => void,
  onRestart: () => void,
) {
  const host = viewport.querySelector<HTMLElement>(
    '.new-workflow-controls-mount',
  );
  if (!host) throw new Error('The workflow controls container is missing.');
  const root = createRoot(host);
  let autoplay = true;
  let active = 0;
  let playback = 0;
  const render = () => {
    root.render(
      <Controls
        key={`${active}:${playback}`}
        step={active}
        progress={Number(slides[active]?.dataset.progress ?? 0)}
        last={active === slides.length - 1}
        autoplay={autoplay}
        onPause={() => {
          autoplay = false;
          render();
        }}
        onReplay={onReplay}
        onNext={onNext}
        onRestart={() => {
          autoplay = true;
          onRestart();
        }}
      />,
    );
  };
  const update = (event: Event) => {
    if (event.target !== slides[active]) return;
    if (slides[active].dataset.progress === '0') playback++;
    render();
  };
  viewport.addEventListener(PROGRESS, update);
  return {
    setStep(step: number) {
      active = step;
      viewport
        .querySelectorAll('.new-workflow-controls-slot')
        [step]?.append(host);
      render();
    },
    dispose() {
      viewport.removeEventListener(PROGRESS, update);
      root.unmount();
    },
  };
}
