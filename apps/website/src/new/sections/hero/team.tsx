import { gsap } from 'gsap';
import {
  AnimatePresence,
  motion,
  useAnimate,
  useReducedMotion,
} from 'motion/react';
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { heroLooks } from '../../bot-looks';
import {
  Klex,
  type KlexActivity,
  type KlexHandle,
  type KlexPosition,
  type MovementMode,
} from '../../klex';
import { KlexGroundGrid } from '../../klex/ground-grid';
import { popTransition } from '../../klex/transitions';
import { botProfileApps, ProfileApps } from '../../profile-card';
import GradualBlur from './react-bits/GradualBlur';
import { HeroWork, type WorkState } from './work';

const bots = [
  {
    id: 'jonathan',
    name: 'Jonathan',
    role: 'Software Engineer',
    mode: 'fly',
  },
  {
    id: 'kristine',
    name: 'Kristine',
    role: 'Product Manager',
    mode: 'hop',
  },
  {
    id: 'monica',
    name: 'Monica',
    role: 'Recruiter',
    mode: 'crawl',
  },
  {
    id: 'jeff',
    name: 'Jeff',
    role: 'Quality Assurance',
    mode: 'hop',
  },
] as const satisfies readonly {
  id: string;
  name: string;
  role: string;
  mode: MovementMode;
}[];

/** The order in which the bots take turns with their apps. */
const botIds = bots.map((bot) => bot.id);

const profiles: Record<string, { work: string }> = {
  jonathan: {
    work: 'Turns Linear tickets into working features and opens pull requests.',
  },
  kristine: {
    work: 'Turns rough ideas in Slack into a plan and clear Linear tickets.',
  },
  monica: {
    work: 'Helps the team hire and welcome new teammates.',
  },
  jeff: {
    work: 'Tests new features, finds edge cases, and leaves precise feedback.',
  },
};

const teamSpread = 1120;
const floorTilt = 68;
const floorDepthScale = 1 / Math.cos((floorTilt * Math.PI) / 180);
/** When the floor has nearly settled, in ms after the team starts. */
const walkAfter = 550;

function trackX(width: number, size: number, px: number) {
  return ((px + size / 2) / (width + size)) * 100 - 50;
}

function HeroBot({
  bot,
  index,
  size,
  width,
  height,
  copyBottom,
  selected,
  profileOpen,
  dimmed,
  placed,
  started,
  reducedMotion,
  activity,
  handles,
  onArrive,
  onSelect,
  onProfile,
  onMoveEnd,
}: {
  bot: (typeof bots)[number];
  index: number;
  size: number;
  width: number;
  height: number;
  /** Where the hero's copy and button end, from the top of the stage. */
  copyBottom: number;
  selected: boolean;
  profileOpen: boolean;
  dimmed: boolean;
  /** The visitor sent this bot somewhere else on the grid. */
  placed: boolean;
  started: boolean;
  reducedMotion: boolean;
  activity: KlexActivity;
  handles: RefObject<Map<string, KlexHandle>>;
  onArrive: () => void;
  onSelect: (id: string) => void;
  onProfile: (id: string, open: boolean) => void;
  onMoveEnd: (id: string) => void;
}) {
  const { color, shape } = heroLooks[bot.id];
  const { work } = profiles[bot.id];
  const klex = useRef<KlexHandle>(null);
  const [layer, animate] = useAnimate<HTMLLIElement>();
  const arrived = useRef(false);
  // Where the bot is on its way to its spot in the team.
  const progress = useRef<'waiting' | 'walking' | 'home'>('waiting');
  const [entered, setEntered] = useState(false);
  const visible = reducedMotion || entered;
  const mobile = width < 650;
  const spotX = [-0.375, -0.125, 0.125, 0.375][index];
  // Stand at the previews' lower edge while keeping every body above the fold.
  const compact = window.innerHeight <= 720;
  const bottomClearance = mobile ? (compact ? 32 : 100) : compact ? 24 : 80;
  const arcTop = Math.min(
    mobile ? 150 : 130,
    Math.max(bottomClearance, height - copyBottom - (mobile ? 300 : 340)),
  );
  const arcDip = mobile ? 0 : 12;
  // Compensate for Jonathan's hover so his body shares the team's baseline.
  const flightLift = bot.mode === 'fly' ? size * 0.45 : 0;
  const spotY =
    (index === 0 || index === 3 ? -arcTop : arcDip - arcTop) + flightLift;
  const entranceOffset = size * (compact ? 0.06 : 0.35);
  // Spread the team over at most teamSpread px so wide screens keep it
  // gathered around the headline.
  const destination: KlexPosition = {
    x: trackX(
      width,
      size,
      width / 2 + Math.min(width, teamSpread) * (spotX ?? 0),
    ),
    y: Math.max(-height * 0.5, spotY),
  };
  // A short approach keeps the entrance lively without a long walk-in.
  const initialPosition: KlexPosition = reducedMotion
    ? destination
    : { x: destination.x, y: destination.y + entranceOffset };
  const spot = useRef(destination);

  // The spot moves with the stage size. Follow it on every resize frame, so
  // the team never drifts apart and walks back once the resize ends.
  useLayoutEffect(() => {
    const next = { x: destination.x, y: destination.y };
    const offset = { x: next.x - spot.current.x, y: next.y - spot.current.y };
    spot.current = next;
    const handle = klex.current;
    if ((!offset.x && !offset.y) || !handle || placed) return;
    if (reducedMotion || progress.current === 'home') handle.snapTo(next);
    // Move the whole path with the layout, including any hop in progress.
    else if (progress.current === 'walking') handle.shiftBy(offset);
    // Keep the short entrance path anchored just below the destination.
    else handle.snapTo({ x: next.x, y: next.y + entranceOffset });
  }, [destination.x, destination.y, entranceOffset, placed, reducedMotion]);

  useLayoutEffect(() => {
    const animation = animate(
      '[data-klex-figure]',
      { scale: visible ? 1 : 0 },
      visible && !reducedMotion ? popTransition : { duration: 0 },
    );
    return () => animation.stop();
  }, [animate, reducedMotion, visible]);

  useLayoutEffect(() => {
    const handle = klex.current;
    if (!handle) return;
    handles.current.set(bot.id, handle);
    return () => {
      handles.current.delete(bot.id);
    };
  }, [bot.id, handles]);

  useEffect(() => {
    if (reducedMotion || !started) return;
    // Pop in while the camera is still moving, then stand and ride the floor
    // like the tiles around them. Walking against a floor that is still
    // sliding looks like a treadmill, so each bot only sets off once the floor
    // has all but settled.
    const popAt = index * 120;
    const revealTimer = window.setTimeout(() => setEntered(true), popAt);
    const moveTimer = window.setTimeout(
      () => {
        progress.current = 'walking';
        klex.current?.moveTo(spot.current, bot.mode);
      },
      Math.max(
        popAt + popTransition.visualDuration * 1000,
        walkAfter + index * 70,
      ),
    );
    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(moveTimer);
    };
  }, [bot.mode, index, reducedMotion, started]);

  const tag = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profileId = `hero-profile-${bot.id}`;
  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const openProfile = () => {
    clearHoverTimer();
    onSelect(bot.id);
    onProfile(bot.id, true);
  };
  const enterProfile = (pointerType: string) => {
    if (pointerType === 'touch') return;
    clearHoverTimer();
    if (!profileOpen) hoverTimer.current = setTimeout(openProfile, 100);
  };
  const leaveProfile = () => {
    clearHoverTimer();
    // Keyboard users can read the card until focus moves away or Escape.
    if (tag.current?.matches(':focus-visible')) return;
    hoverTimer.current = setTimeout(() => onProfile(bot.id, false), 180);
  };
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!profileOpen) return;
    const isInside = (target: EventTarget | null) =>
      target instanceof Node &&
      [tag.current, trigger.current, card.current].some((node) =>
        node?.contains(target),
      );
    const dismiss = (event: Event) => {
      if (!isInside(event.target)) onProfile(bot.id, false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onProfile(bot.id, false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [bot.id, onProfile, profileOpen]);
  useLayoutEffect(() => {
    if (!profileOpen) return;
    // Follow the animated figure without rerendering the whole hero each frame.
    const place = () => {
      const bounds = tag.current?.parentElement?.getBoundingClientRect();
      if (!bounds || !card.current) return;
      const width = card.current.offsetWidth;
      card.current.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, bounds.left + bounds.width / 2 - width / 2))}px`;
      card.current.style.bottom = `${window.innerHeight - bounds.bottom}px`;
      card.current.style.maxHeight = `${Math.max(0, bounds.bottom - 12)}px`;
    };
    place();
    gsap.ticker.add(place);
    return () => {
      gsap.ticker.remove(place);
    };
  }, [profileOpen]);
  const tagBounds = tag.current?.parentElement?.getBoundingClientRect();

  return (
    <li
      ref={layer}
      className={`new-bot${visible ? ' is-visible' : ''}${dimmed ? ' is-dimmed' : ''}`}
      aria-hidden={!visible}
      data-bot={bot.id}
      style={
        {
          '--bot-size': `${size}px`,
          '--bot-depth': Math.round(height + destination.y),
        } as CSSProperties
      }
    >
      <Klex
        ref={klex}
        shape={shape}
        color={color}
        movementMode={heroLooks[bot.id].movementMode}
        size={size}
        width="100%"
        activity={activity}
        initialPosition={initialPosition}
        // App demos can start at the destination while the body settles.
        onMoveArrival={() => {
          if (!arrived.current) {
            arrived.current = true;
            onArrive();
          }
        }}
        onMoveComplete={() => {
          if (progress.current === 'walking') progress.current = 'home';
          onMoveEnd(bot.id);
        }}
        onDepthChange={(y) => {
          if (layer.current)
            layer.current.style.setProperty(
              '--bot-depth',
              String(Math.round(height + y)),
            );
        }}
      >
        <button
          type="button"
          ref={trigger}
          className="new-bot-trigger"
          disabled={!visible}
          tabIndex={-1}
          aria-label={`${bot.name}, ${bot.role}. Show details`}
          aria-expanded={profileOpen}
          aria-controls={profileOpen ? profileId : undefined}
          aria-pressed={selected}
          onPointerEnter={(event) => enterProfile(event.pointerType)}
          onPointerLeave={leaveProfile}
          onClick={() => {
            clearHoverTimer();
            onSelect(bot.id);
            onProfile(bot.id, !profileOpen);
            klex.current?.emote('hello');
          }}
        />
        <div className="new-bot-tag-anchor">
          <motion.button
            type="button"
            ref={tag}
            layoutId={reducedMotion ? undefined : profileId}
            transition={{
              duration: reducedMotion ? 0 : 0.24,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="new-bot-tag"
            style={{ opacity: profileOpen ? 0 : 1, borderRadius: 10 }}
            disabled={!visible}
            aria-label={`${bot.name}, ${bot.role}. Show details`}
            aria-expanded={profileOpen}
            aria-controls={profileOpen ? profileId : undefined}
            aria-describedby={profileOpen ? `${profileId}-work` : undefined}
            onPointerEnter={(event) => enterProfile(event.pointerType)}
            onPointerLeave={leaveProfile}
            onFocus={(event) => {
              if (event.currentTarget.matches(':focus-visible')) openProfile();
            }}
            onBlur={leaveProfile}
            onClick={() => {
              clearHoverTimer();
              onSelect(bot.id);
              onProfile(bot.id, !profileOpen);
            }}
          >
            <span>{bot.name}</span>
            {!mobile && <span className="new-klex-name-role">{bot.role}</span>}
          </motion.button>
        </div>
        {createPortal(
          <AnimatePresence>
            {profileOpen && (
              <motion.div
                ref={card}
                id={profileId}
                role="tooltip"
                aria-label={`${bot.name}, ${bot.role}`}
                layoutId={reducedMotion ? undefined : profileId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: reducedMotion ? 0 : 0.24,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="new-member-hover-card new-hero-hover-card"
                style={{
                  borderRadius: 10,
                  left: Math.max(
                    12,
                    Math.min(
                      window.innerWidth - 268,
                      (tagBounds ? tagBounds.left + tagBounds.width / 2 : 128) -
                        128,
                    ),
                  ),
                  bottom: window.innerHeight - (tagBounds?.bottom ?? 0),
                }}
                onPointerEnter={clearHoverTimer}
                onPointerLeave={leaveProfile}
              >
                <div className="new-member-hover-card-identity">
                  <span>{bot.name}</span>
                  <span className="new-klex-name-role">{bot.role}</span>
                </div>
                <p id={`${profileId}-work`}>{work}</p>
                <ProfileApps
                  name={bot.name}
                  apps={botProfileApps[bot.id] ?? []}
                />
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
      </Klex>
    </li>
  );
}

function HeroTeam({ entrance }: { entrance: Promise<void> }) {
  const stage = useRef<HTMLDivElement>(null);
  const ground = useRef<HTMLDivElement>(null);
  const team = useRef<HTMLUListElement>(null);
  const [started, setStarted] = useState(false);
  const handles = useRef(new Map<string, KlexHandle>());
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [copyBottom, setCopyBottom] = useState(0);
  const [selectedId, setSelectedId] = useState<string>(bots[0].id);
  const [arrivalCount, setArrivalCount] = useState(0);
  const ready = started && arrivalCount === bots.length;
  const [activities, setActivities] = useState<Record<string, KlexActivity>>(
    {},
  );
  const [profiles, setProfiles] = useState<string[]>([]);
  // An open profile takes priority over the working bot's visual emphasis.
  const focusedId = profiles.at(-1) ?? null;
  const focusedIds = focusedId
    ? [focusedId]
    : botIds.filter((id) => activities[id] === 'working');
  // Bots the visitor sent walking across the grid.
  const [moving, setMoving] = useState<string[]>([]);
  // Bots the visitor sent somewhere keep that place when the stage resizes.
  const [placed, setPlaced] = useState<string[]>([]);
  // Moving bots pause their demos; an open profile hides all app previews.
  const busy = useMemo(() => [...new Set(moving)], [moving]);
  const [inView, setInView] = useState(true);
  const reducedMotion = useReducedMotion() ?? false;
  // Phones fit all four bots in one row, so they are a bit smaller there.
  const size =
    dimensions.width < 650
      ? Math.max(56, Math.min(80, dimensions.width * 0.16))
      : Math.max(72, Math.min(118, dimensions.width * 0.095));

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    // Render in the same frame as the resize, so the bots never lag behind.
    const observer = new ResizeObserver(() => {
      flushSync(() =>
        setDimensions({
          width: element.clientWidth,
          height: element.clientHeight,
        }),
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Size the floor so it fades out right below the headline on any screen.
  // Compensate for the floor tilt so its far edge still meets the headline.
  // Also tracks where the copy and its button end, so the team never crowds
  // them.
  useLayoutEffect(() => {
    const element = stage.current;
    const floor = ground.current;
    const hero = element?.closest('.new-hero');
    const headline = hero?.querySelector<HTMLElement>('h1');
    const cta = hero?.querySelector<HTMLElement>('.new-hero-cta');
    if (!element || !floor || !headline || !cta) return;
    const observer = new ResizeObserver(() => {
      const reach =
        element.clientHeight - (headline.offsetTop + headline.offsetHeight);
      floor.style.setProperty(
        '--floor-radius',
        `${Math.max(0, reach) * floorDepthScale}px`,
      );
      flushSync(() => setCopyBottom(cta.offsetTop + cta.offsetHeight));
    });
    observer.observe(element);
    observer.observe(headline);
    observer.observe(cta);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    void entrance.then(() => {
      if (active) setStarted(true);
    });
    return () => {
      active = false;
    };
  }, [entrance]);

  // The hero reveals its description as the first bot sets off.
  useEffect(() => {
    if (!started && !reducedMotion) return;
    const reveal = () =>
      stage.current?.closest('.new-hero')?.classList.add('has-walk');
    if (reducedMotion) {
      reveal();
      return;
    }
    const timer = window.setTimeout(reveal, walkAfter);
    return () => window.clearTimeout(timer);
  }, [started, reducedMotion]);

  // Reveal the "See how…" link when the team is ready to use its apps.
  useEffect(() => {
    if (!ready && !reducedMotion) return;
    stage.current?.closest('.new-hero')?.classList.add('has-apps');
  }, [ready, reducedMotion]);

  // While the ground tilts into place, project where each bot stands right
  // now through the floor's current transform, so the team walks on the
  // moving floor. Bots stay upright and only scale with their distance to
  // the camera.
  useEffect(() => {
    const floor = ground.current?.querySelector('svg');
    const list = team.current;
    if (!floor || !list) return;
    const each = (update: (bot: HTMLElement) => void) => {
      for (const bot of list.querySelectorAll<HTMLElement>('.new-bot'))
        update(bot);
    };
    const place = () => {
      const matrix = new DOMMatrix(getComputedStyle(floor).transform);
      each((bot) => {
        const travel = bot.querySelector<HTMLElement>(
          '[data-testid="klex-travel"]',
        );
        if (!travel) return;
        // The track spans the stage, centered on the bot's layer, and the
        // glide stores the bot's spot on it as xPercent plus a ground y.
        const x =
          (travel.offsetWidth * Number(gsap.getProperty(travel, 'xPercent'))) /
          100;
        const y = Number(gsap.getProperty(travel, 'y'));
        // Undo the settled tilt's depth compression before projecting through
        // the current camera transform, keeping feet planted on the tiles.
        const spot = matrix.transformPoint(
          new DOMPoint(x, y * floorDepthScale),
        );
        bot.style.transformOrigin = `calc(50% + ${x}px) calc(100% + ${y}px)`;
        bot.style.translate = `${spot.x / spot.w - x}px ${spot.y / spot.w - y}px`;
        bot.style.scale = String(1 / spot.w);
      });
    };
    const settle = () => {
      gsap.ticker.remove(place);
      each((bot) => {
        bot.style.transformOrigin = '';
        bot.style.translate = '';
        bot.style.scale = '';
      });
    };
    const onStart = (event: TransitionEvent) => {
      if (event.target !== floor || event.propertyName !== 'transform') return;
      // Added after the bots' own glide, so it runs once they have moved.
      gsap.ticker.add(place);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === floor && event.propertyName === 'transform')
        settle();
    };
    floor.addEventListener('transitionstart', onStart);
    floor.addEventListener('transitionend', onEnd);
    floor.addEventListener('transitioncancel', onEnd);
    return () => {
      floor.removeEventListener('transitionstart', onStart);
      floor.removeEventListener('transitionend', onEnd);
      floor.removeEventListener('transitioncancel', onEnd);
      settle();
    };
  }, []);

  // Bots only start new work while the hero is on screen.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) =>
      setInView(entry.isIntersecting),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onWork = useCallback((id: string, state: WorkState) => {
    setActivities((current) => ({
      ...current,
      [id]: state === 'working' ? 'working' : 'idle',
    }));
    if (state === 'working') return;
    if (state === 'done') handles.current.get(id)?.emote('happy-nod');
  }, []);
  const onMoveEnd = useCallback((id: string) => {
    setMoving((current) => current.filter((entry) => entry !== id));
  }, []);
  const onProfile = useCallback((id: string, open: boolean) => {
    setProfiles((current) =>
      open ? [id] : current.filter((entry) => entry !== id),
    );
  }, []);

  const onArrive = useCallback(() => setArrivalCount((count) => count + 1), []);

  return (
    <div ref={stage} className="new-hero-stage">
      <div
        ref={ground}
        className="new-hero-ground"
        style={
          {
            '--floor-tilt': `${floorTilt}deg`,
            '--floor-depth-scale': floorDepthScale,
          } as CSSProperties
        }
      >
        <KlexGroundGrid floor />
        <GradualBlur
          target="parent"
          position="top"
          height="65%"
          strength={0.5}
          divCount={5}
          curve="bezier"
          zIndex={0}
        />
        <GradualBlur
          target="parent"
          position="bottom"
          height="20%"
          strength={0.25}
          divCount={5}
          curve="bezier"
          zIndex={0}
        />
      </div>
      <button
        type="button"
        className="new-grid-target"
        aria-label="Move the selected Klex on the grid"
        onClick={(event) => {
          const bounds = stage.current?.getBoundingClientRect();
          if (!bounds) return;
          const x =
            event.detail === 0 ? bounds.width / 2 : event.clientX - bounds.left;
          const y =
            event.detail === 0
              ? bounds.height * 0.7
              : event.clientY - bounds.top;
          setMoving((current) =>
            current.includes(selectedId) ? current : [...current, selectedId],
          );
          setPlaced((current) =>
            current.includes(selectedId) ? current : [...current, selectedId],
          );
          handles.current.get(selectedId)?.moveTo(
            {
              x: trackX(bounds.width, size, x),
              y: Math.max(
                -bounds.height * 0.5,
                Math.min(-150, y - bounds.height),
              ),
            },
            bots.find((bot) => bot.id === selectedId)?.mode,
          );
        }}
      />
      {!reducedMotion && (
        <HeroWork
          team={() => team.current}
          order={botIds}
          ready={ready}
          busy={busy}
          blocked={focusedId !== null}
          active={inView}
          onWork={onWork}
        />
      )}
      <ul
        ref={team}
        className="new-team"
        aria-label="Meet your digital coworkers"
      >
        {dimensions.width > 0 &&
          bots.map((bot, index) => (
            <HeroBot
              key={bot.id}
              bot={bot}
              index={index}
              size={size}
              width={dimensions.width}
              height={dimensions.height}
              copyBottom={copyBottom}
              selected={selectedId === bot.id}
              profileOpen={focusedId === bot.id}
              dimmed={focusedIds.length > 0 && !focusedIds.includes(bot.id)}
              placed={placed.includes(bot.id)}
              started={started}
              reducedMotion={reducedMotion}
              activity={activities[bot.id] ?? 'idle'}
              handles={handles}
              onArrive={onArrive}
              onSelect={setSelectedId}
              onProfile={onProfile}
              onMoveEnd={onMoveEnd}
            />
          ))}
      </ul>
    </div>
  );
}

export function mountHeroTeam(container: HTMLElement, entrance: Promise<void>) {
  const root = createRoot(container);
  root.render(<HeroTeam entrance={entrance} />);
  return () => root.unmount();
}
