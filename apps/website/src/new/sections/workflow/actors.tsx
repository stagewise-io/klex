import { animate } from 'motion';
import {
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { heroLooks } from '../../bot-looks';
import { Klex, type KlexActivity, type KlexHandle } from '../../klex';
import { DEFAULT_GLIDE } from '../../klex/presets';
import { popTransition } from '../../klex/transitions';

const names = {
  monica: 'Monica',
  kristine: 'Kristine',
  jonathan: 'Jonathan',
  jeff: 'Jeff',
} as const;
export type BotId = keyof typeof names;
export type BotSpot = () => {
  x: number;
  y: number;
  speech?: 'left' | 'right';
  facing?: 'left' | 'right';
};
type ActorHandle = {
  place(spot: BotSpot): void;
  pop(spot: BotSpot): void;
  move(spot: BotSpot, signal?: AbortSignal): Promise<void>;
  hide(): void;
  rest(): void;
  visible(): boolean;
  spot(): BotSpot | null;
  say: KlexHandle['say'];
  emote: KlexHandle['emote'];
  setActivity(activity: KlexActivity): void;
};
const walking = { ...DEFAULT_GLIDE, speed: 380 };
const stages = new WeakMap<Element, Map<BotId, ActorHandle>>();

export function workflowActor(host: Element, bot: BotId) {
  const viewport = host.closest('.new-workflow-viewport');
  return viewport ? stages.get(viewport)?.get(bot) : undefined;
}

function Actor({
  bot,
  size,
  layoutRevision,
  ref,
}: {
  bot: BotId;
  size: number;
  layoutRevision: number;
  ref: Ref<ActorHandle>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const klex = useRef<KlexHandle>(null);
  const destination = useRef<BotSpot>(null);
  const arrival = useRef<() => void>(undefined);
  const entrance = useRef<ReturnType<typeof animate>>(undefined);
  const [activity, setActivity] = useState<KlexActivity>('idle');
  const visible = () => frame.current?.style.visibility === 'visible';
  const position = useCallback(
    (spot: BotSpot) => {
      const target = spot();
      const rect = frame.current!.getBoundingClientRect();
      const panelWidth = frame.current!.closest<HTMLElement>(
        '.new-workflow-track',
      )!.clientWidth;
      // Keep bubble bounds local to its slide, even while the track moves.
      const speechX =
        (((target.x - rect.left) % panelWidth) + panelWidth) % panelWidth;
      frame.current!.style.setProperty('--workflow-speech-x', `${speechX}px`);
      frame.current!.style.setProperty(
        '--workflow-speech-width',
        `${panelWidth}px`,
      );
      frame.current!.dataset.speechSide = target.speech ?? 'right';
      return {
        x:
          ((target.x - rect.left - rect.width / 2) / (rect.width - size)) * 100,
        y: target.y - rect.top - size,
      };
    },
    [size],
  );
  const stop = () => {
    klex.current?.stopMoving();
    const complete = arrival.current;
    arrival.current = undefined;
    complete?.();
  };
  const rest = () => {
    klex.current?.say(null);
    klex.current?.cancelEmote();
    setActivity('idle');
  };
  const place = (spot: BotSpot) => {
    entrance.current?.stop();
    frame.current!.querySelector<HTMLElement>(
      '[data-klex-figure]',
    )!.style.transform = '';
    stop();
    rest();
    destination.current = spot;
    klex.current?.snapTo(position(spot));
    const facing = spot().facing;
    if (facing) klex.current?.face(facing);
    frame.current!.style.visibility = 'visible';
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutRevision invalidates DOM measurements even when the actor size is unchanged.
  useLayoutEffect(() => {
    if (!destination.current) return;
    const target = position(destination.current);
    if (arrival.current) klex.current?.moveTo(target);
    else klex.current?.snapTo(target);
  }, [position, layoutRevision]);
  useLayoutEffect(() => () => entrance.current?.stop(), []);
  useImperativeHandle(ref, () => ({
    place,
    pop(spot) {
      place(spot);
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const figure =
        frame.current!.querySelector<HTMLElement>('[data-klex-figure]')!;
      entrance.current = animate(figure, { scale: [0, 1] }, popTransition);
    },
    visible,
    spot: () => destination.current,
    rest,
    async move(spot, signal) {
      signal?.throwIfAborted();
      if (!visible()) {
        place(spot);
        return;
      }
      stop();
      destination.current = spot;
      let abort = () => {};
      await new Promise<void>((resolve) => {
        arrival.current = resolve;
        abort = () => {
          if (arrival.current === resolve) stop();
        };
        signal?.addEventListener('abort', abort, { once: true });
        klex.current?.moveTo(position(spot));
      });
      signal?.removeEventListener('abort', abort);
      signal?.throwIfAborted();
    },
    hide() {
      entrance.current?.stop();
      stop();
      destination.current = null;
      frame.current!.style.visibility = 'hidden';
      rest();
    },
    say: (...args) => klex.current?.say(...args),
    emote: (...args) => klex.current?.emote(...args) ?? false,
    setActivity,
  }));
  return (
    <div
      ref={frame}
      className="new-workflow-actor"
      data-workflow-bot={bot}
      style={{ visibility: 'hidden' }}
      aria-hidden="true"
    >
      <Klex
        ref={klex}
        name={names[bot]}
        {...heroLooks[bot]}
        size={size}
        width="100%"
        activity={activity}
        settings={walking}
        onMoveArrival={() => {
          const facing = destination.current?.().facing;
          if (facing) klex.current?.face(facing);
          const complete = arrival.current;
          arrival.current = undefined;
          complete?.();
        }}
      />
    </div>
  );
}

export function mountWorkflowActors(track: HTMLElement) {
  const viewport = track.closest('.new-workflow-viewport')!;
  const actors = new Map<BotId, ActorHandle>();
  stages.set(viewport, actors);
  const host = document.createElement('div');
  host.className = 'new-workflow-actors';
  track.append(host);
  const root = createRoot(host);
  let layoutRevision = 0;
  const render = () => {
    layoutRevision++;
    const size =
      128 * Math.min(1, track.clientWidth / 736, track.clientHeight / 576);
    root.render(
      <>
        {(Object.keys(names) as BotId[]).map((bot) => (
          <Actor
            key={bot}
            bot={bot}
            size={size}
            layoutRevision={layoutRevision}
            ref={(actor) => {
              if (actor) actors.set(bot, actor);
              else actors.delete(bot);
            }}
          />
        ))}
      </>,
    );
  };
  flushSync(render);
  const resize = new ResizeObserver(render);
  resize.observe(track);
  for (const artwork of track.querySelectorAll('.new-workflow-artwork'))
    resize.observe(artwork);
  return {
    checkpoint() {
      const spots = [...actors].map(
        ([bot, actor]) => [bot, actor.spot()] as const,
      );
      return () => {
        for (const [bot, spot] of spots) {
          const actor = actors.get(bot)!;
          if (spot) actor.place(spot);
          else actor.hide();
        }
      };
    },
    reset: () => {
      for (const actor of actors.values()) actor.hide();
    },
    dispose: () => {
      resize.disconnect();
      root.unmount();
      stages.delete(viewport);
      host.remove();
    },
  };
}
