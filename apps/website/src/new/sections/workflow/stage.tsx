import './stage.css';

import {
  type Ref,
  type RefObject,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import type { EmoteId, KlexActivity } from '../../klex';

export const STEP_ENTER = 'new-workflow-step-enter';
export const STEP_LEAVE = 'new-workflow-step-leave';
export const STEP_RESET = 'new-workflow-step-reset';
export const STEP_FINISH = 'new-workflow-step-finish';

export type { BotId } from './actors';

import { type BotId, type BotSpot, workflowActor } from './actors';

const reducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Resolves after ms, or rejects once the step is left. */
export function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      reducedMotion() ? 0 : ms,
    );
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function typeText(
  text: string,
  write: (value: string) => void,
  signal: AbortSignal,
  step = 2,
) {
  signal.throwIfAborted();
  if (reducedMotion()) {
    write(text);
    return;
  }
  for (let length = step; length < text.length; length += step) {
    write(text.slice(0, length));
    await wait(24, signal);
  }
  write(text);
}

/**
 * Reset and finish remount the scene at the requested story boundary.
 * Completed scenes stay mounted above the current scene.
 */
export function useStepPlayback() {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({
    run: 0,
    playing: false,
    finished: false,
    skipArrival: false,
  });

  useEffect(() => {
    const slide = host.current?.closest('.new-workflow-slide');
    if (!slide) throw new Error('A workflow story must live in a slide.');
    const events = new AbortController();
    slide.addEventListener(
      STEP_ENTER,
      (event) => {
        const skipArrival =
          (event as CustomEvent<{ skipArrival: boolean }>).detail
            ?.skipArrival ?? false;
        setState((current) =>
          current.finished
            ? current
            : { ...current, run: current.run + 1, playing: true, skipArrival },
        );
      },
      { signal: events.signal },
    );
    slide.addEventListener(
      STEP_RESET,
      () => {
        setState(({ run }) => ({
          run: run + 1,
          playing: false,
          finished: false,
          skipArrival: false,
        }));
      },
      { signal: events.signal },
    );
    slide.addEventListener(
      STEP_FINISH,
      () => {
        setState(({ run }) => ({
          run: run + 1,
          playing: false,
          finished: true,
          skipArrival: false,
        }));
      },
      { signal: events.signal },
    );
    return () => events.abort();
  }, []);

  return {
    host,
    ...state,
    onComplete: () => {
      setState((current) => ({ ...current, playing: false, finished: true }));
    },
  };
}

/** Runs the story while playing and cancels it when the step is left. */
export function usePlay(
  playing: boolean,
  story: (signal: AbortSignal) => Promise<void>,
  onComplete: () => void,
) {
  const play = useEffectEvent(story);
  const complete = useEffectEvent(onComplete);
  useEffect(() => {
    if (!playing) return;
    const controller = new AbortController();
    play(controller.signal)
      .then(() => {
        if (!controller.signal.aborted) complete();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });
    return () => controller.abort();
  }, [playing]);
}

/** Right-hand bots speak to their left so the bubble stays on screen. */
type SpeechSide = 'left' | 'right';

type BotControls = {
  say(text: string | null): void;
  emote(id: EmoteId): void;
  setActivity(activity: KlexActivity): void;
};

/** `offset` moves the bot's center from the anchor point, in bot widths. */
export type Spot =
  | 'offstage-top'
  | 'offstage-bottom'
  | 'slack-home'
  | {
      edge: 'left' | 'center' | 'right';
      offset?: number;
      vertical?: 'center' | 'bottom';
    };

export type WalkingBotHandle = BotControls & {
  walkTo(spot: Spot, signal?: AbortSignal, instant?: boolean): Promise<void>;
};

/** Scene markers address the persistent actors on the shared workflow stage. */
function useActorSpot(
  host: RefObject<HTMLDivElement | null>,
  bot: BotId,
  restore: () => void,
) {
  const enter = useEffectEvent(restore);
  useEffect(() => {
    const slide = host.current?.closest('.new-workflow-slide');
    if (!slide) return;
    const leave = () => {
      const actor = workflowActor(slide, bot);
      actor?.rest();
    };
    slide.addEventListener(STEP_ENTER, enter);
    slide.addEventListener(STEP_LEAVE, leave);
    if (slide.getAttribute('aria-hidden') !== 'true') enter();
    return () => {
      slide.removeEventListener(STEP_ENTER, enter);
      slide.removeEventListener(STEP_LEAVE, leave);
    };
  }, [host, bot]);
  return () => (host.current ? workflowActor(host.current, bot) : undefined);
}

export function WalkingBot({
  ref,
  bot,
  anchor,
  start = 'offstage-top',
  settled = false,
  speech = 'right',
}: {
  ref: Ref<WalkingBotHandle>;
  bot: BotId;
  anchor: RefObject<HTMLElement | null>;
  start?: Spot;
  settled?: boolean;
  speech?: SpeechSide;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Element>(null);
  const spot =
    (location: Spot): BotSpot =>
    () => {
      const marker = scene.current!.querySelector<HTMLElement>(
        `[data-bot-marker="${bot}"]`,
      )!;
      const box = marker.getBoundingClientRect();
      const scale = box.width / marker.offsetWidth;
      if (location === 'slack-home') {
        const home = marker
          .closest('.new-workflow-viewport')!
          .querySelector('.new-slack-monica-mount')!
          .getBoundingClientRect();
        return { x: home.left + home.width / 2, y: home.bottom, speech };
      }
      if (location === 'offstage-top' || location === 'offstage-bottom') {
        const viewport = marker
          .closest('.new-workflow-viewport')!
          .getBoundingClientRect();
        return {
          x: box.left + box.width / 2,
          y:
            location === 'offstage-top'
              ? viewport.top - 128
              : viewport.bottom + 128,
          speech,
        };
      }
      const target = (
        anchor.current ?? marker.parentElement!
      ).getBoundingClientRect();
      const point = {
        left: target.left,
        center: target.left + target.width / 2,
        right: target.right,
      }[location.edge];
      const stage = scene.current!.getBoundingClientRect();
      // The body's center sits 58 SVG units above Klex's travel origin.
      return {
        x: point + (location.offset ?? 0) * 128 * scale,
        y:
          location.vertical === 'center'
            ? stage.top + stage.height / 2 + (58 / 160) * 128 * scale
            : box.bottom,
        speech,
      };
    };
  const actor = useActorSpot(host, bot, () => {
    const current = actor();
    if (settled || !current?.visible()) current?.place(spot(start));
  });
  useImperativeHandle(ref, () => ({
    walkTo: async (location, signal, instant = false) => {
      signal?.throwIfAborted();
      if (instant) actor()?.place(spot(location));
      else await actor()?.move(spot(location), signal);
    },
    say: (text) => actor()?.say(text),
    emote: (id) => actor()?.emote(id),
    setActivity: (activity) => actor()?.setActivity(activity),
  }));
  return (
    <div
      ref={(element) => {
        host.current = element;
        if (element) scene.current = element.closest('.new-workflow-slide');
      }}
      data-bot-marker={bot}
      className="new-stage-track"
      aria-hidden="true"
    />
  );
}

export type PopBotHandle = BotControls & {
  show(signal?: AbortSignal, instant?: boolean): Promise<void>;
};

export function PopBot({
  ref,
  bot,
  className,
  visible = false,
  speech = 'right',
  facing,
}: {
  ref: Ref<PopBotHandle>;
  bot: BotId;
  className?: string;
  visible?: boolean;
  speech?: SpeechSide;
  facing?: 'left' | 'right';
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Element>(null);
  const spot: BotSpot = () => {
    const box = scene
      .current!.querySelector(`[data-bot-marker="${bot}"]`)!
      .getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.bottom, speech, facing };
  };
  const actor = useActorSpot(host, bot, () => {
    if (visible) actor()?.place(spot);
  });
  useImperativeHandle(ref, () => ({
    show: async (signal, instant = false) => {
      signal?.throwIfAborted();
      const current = actor();
      if (instant) current?.place(spot);
      else if (current?.visible()) await current.move(spot, signal);
      else {
        current?.pop(spot);
        current?.emote('hello');
      }
    },
    say: (text) => actor()?.say(text),
    emote: (id) => actor()?.emote(id),
    setActivity: (activity) => actor()?.setActivity(activity),
  }));
  return (
    <div
      ref={(element) => {
        host.current = element;
        if (element) scene.current = element.closest('.new-workflow-slide');
      }}
      data-bot-marker={bot}
      className={`new-stage-pop ${className ?? ''}`}
      aria-hidden="true"
    />
  );
}
