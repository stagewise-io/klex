import './klex/name-tag.css';

import { useReducedMotion } from 'motion/react';
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Badge } from '@stagewise/ui/src/components/ui/badge.tsx';

import type { KlexActivity } from './klex/activity';
import { EMOTES, type Emote, type EmoteLook } from './klex/emotes';
import { type Extra, KlexExtras } from './klex/extras';
import { type Expression, KlexEyes } from './klex/eyes';
import { waveAnchor } from './klex/geometry';
import { createGlide, type KlexPosition, klexBody } from './klex/glide';
import { KlexLaptop } from './klex/laptop';
import {
  BODY_SHAPES,
  type BodyShape,
  DEFAULT_GLIDE,
  getKlexEyeColor,
  MOVEMENT_STYLES,
  type MovementMode,
  PALETTES,
} from './klex/presets';
import { KlexSpeech, type KlexSpeechValue } from './klex/speech';

export type {
  BodyShape,
  Expression,
  Extra,
  KlexActivity,
  KlexPosition,
  MovementMode,
};
export type EmoteId = Emote['id'];

export type KlexHandle = {
  /** X runs from -50 (left) to 50 (right); Y is a pixel offset from the track. */
  moveTo(
    target: 'left' | 'right' | number | KlexPosition,
    mode?: MovementMode,
  ): void;
  /** Restore a saved scene position without replaying travel. */
  snapTo(target: KlexPosition): void;
  /** Shift the current position and destination without interrupting travel. */
  shiftBy(offset: KlexPosition): void;
  /** Set the resting direction without moving. */
  face(side: 'left' | 'right'): void;
  /** Stop travel at the current position without completing its destination. */
  stopMoving(): void;
  /** Returns false while another emote is active or reduced motion is enabled. */
  emote(id: EmoteId): boolean;
  /** Show custom speech without interrupting body emotes. Pass null to dismiss. */
  say(text: string | null, options?: { waiting?: boolean }): void;
  setExpression(expression: Expression): void;
  /** Select one extra, or 'none' to hide it. */
  setExtra(extra: Extra): void;
  cancelEmote(): void;
  pause(): void;
  resume(): void;
};

export type KlexProps = {
  ref?: Ref<KlexHandle>;
  children?: ReactNode;
  name?: string;
  /** Shown under the name in the name tag, e.g. the bot's job. */
  role?: string;
  shape?: BodyShape;
  color?: string;
  /** Character width in pixels. Movement and emotes scale with it. */
  size?: number;
  /** Disable the default idle animation. Sleeping and working still animate. */
  idle?: boolean;
  /** Persistent resting animation. Resumes after travel and emotes. */
  activity?: KlexActivity;
  /** Total track width. Defaults to size for a stationary avatar. */
  width?: CSSProperties['width'];
  /** Initial track position. Y is a pixel offset from the ground line. */
  initialPosition?: KlexPosition;
  /** Center the animated character inside its own viewport. */
  layout?: 'track' | 'avatar';
  className?: string;
  initialExpression?: Expression;
  initialExtra?: Extra;
  extrasEnabled?: boolean;
  settings?: typeof DEFAULT_GLIDE;
  /** Lock a character's locomotion across travel, rest, and caller overrides. */
  movementMode?: MovementMode;
  onMoveComplete?: () => void;
  /** Destination reached, before the body's final settling animation. */
  onMoveArrival?: () => void;
  /** Reports the ground line's Y offset as the character moves. */
  onDepthChange?: (y: number) => void;
  /** Also fires when the active emote is cancelled. */
  onEmoteComplete?: () => void;
};

export function Klex({
  ref,
  children,
  name,
  role,
  shape = BODY_SHAPES[0],
  color = PALETTES[0].body,
  size = 160,
  idle = true,
  activity = 'idle',
  width = size,
  initialPosition,
  layout = 'track',
  className,
  initialExpression = 'neutral',
  initialExtra = 'none',
  extrasEnabled = true,
  settings: suppliedSettings,
  movementMode,
  onMoveComplete,
  onMoveArrival,
  onDepthChange,
  onEmoteComplete,
}: KlexProps) {
  const settings = useMemo(() => {
    const base =
      suppliedSettings ??
      MOVEMENT_STYLES.find((preset) => preset.id === movementMode)?.settings ??
      DEFAULT_GLIDE;
    return movementMode ? { ...base, mode: movementMode } : base;
  }, [suppliedSettings, movementMode]);
  const eyeColor = getKlexEyeColor(color);
  const [expression, setExpression] = useState(initialExpression);
  const [extra, setExtra] = useState(initialExtra);
  const [paused, setPaused] = useState(false);
  const [speech, setSpeech] = useState<KlexSpeechValue | null>(null);
  const [reactionLook, setReactionLook] = useState<EmoteLook>({});
  const reducedMotion = useReducedMotion() ?? false;
  const travelRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<SVGEllipseElement>(null);
  const bodyRef = useRef<SVGPathElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const laptopRef = useRef<SVGGElement>(null);
  const motionRef = useRef<ReturnType<typeof createGlide> | null>(null);
  const currentSettings = useRef(settings);
  const startingPosition = useRef(initialPosition);
  const restingBody = useMemo(
    () => klexBody(undefined, undefined, shape),
    [shape],
  );
  const handAnchor = useMemo(() => waveAnchor(shape), [shape]);
  const scale = size / 160;
  const avatarLayout = layout === 'avatar';
  const viewBox = avatarLayout ? '0 -10 160 160' : '0 0 160 140';
  const completeMove = useEffectEvent(() => onMoveComplete?.());
  const arrive = useEffectEvent(() => onMoveArrival?.());
  const reportDepth = useEffectEvent((y: number) => onDepthChange?.(y));
  const completeEmote = useEffectEvent(() => onEmoteComplete?.());
  const configureSettings = useEffectEvent((next: typeof DEFAULT_GLIDE) => {
    motionRef.current?.configure(
      next,
      reducedMotion,
      shape,
      scale,
      idle,
      activity,
    );
  });

  useLayoutEffect(() => {
    const travel = travelRef.current;
    const actor = actorRef.current;
    const shadow = shadowRef.current;
    const body = bodyRef.current;
    const eyes = eyesRef.current;
    const laptop = laptopRef.current;
    if (!travel || !actor || !shadow || !body || !eyes || !laptop) return;

    const motion = createGlide(
      { travel, actor, shadow, body, eyes, laptop },
      completeMove,
      completeEmote,
      setReactionLook,
      currentSettings.current,
      startingPosition.current,
      reportDepth,
      arrive,
    );
    motionRef.current = motion;
    return () => {
      motion.dispose();
      motionRef.current = null;
    };
  }, []);

  // Keep a mode chosen by moveTo until the caller supplies new settings.
  useLayoutEffect(() => {
    currentSettings.current = settings;
    configureSettings(settings);
  }, [settings]);

  useLayoutEffect(() => {
    motionRef.current?.configure(
      currentSettings.current,
      reducedMotion,
      shape,
      scale,
      idle,
      activity,
    );
  }, [reducedMotion, shape, scale, idle, activity]);

  useImperativeHandle(ref, () => ({
    moveTo(target, mode) {
      const motion = motionRef.current;
      if (!motion) return;
      if (mode && !movementMode) {
        currentSettings.current =
          MOVEMENT_STYLES.find((preset) => preset.id === mode)?.settings ??
          currentSettings.current;
        motion.configure(
          currentSettings.current,
          reducedMotion,
          shape,
          scale,
          idle,
          activity,
        );
      }
      motion.moveTo(target === 'left' ? -50 : target === 'right' ? 50 : target);
      setPaused(false);
      motion.pause(false);
    },
    snapTo: (target) => motionRef.current?.snapTo(target),
    shiftBy: (offset) => motionRef.current?.shiftBy(offset),
    face: (side) => motionRef.current?.face(side),
    stopMoving: () => motionRef.current?.stopMoving(),
    emote(id) {
      const action = EMOTES.find((entry) => entry.id === id);
      const motion = motionRef.current;
      if (!action || !motion?.playEmote(action)) return false;
      setPaused(false);
      motion.pause(false);
      return true;
    },
    say(text, options) {
      setSpeech(text ? { text, waiting: options?.waiting } : null);
    },
    setExpression,
    setExtra,
    cancelEmote: () => motionRef.current?.cancelEmote(),
    pause: () => {
      setPaused(true);
      motionRef.current?.pause(true);
    },
    resume: () => {
      setPaused(false);
      motionRef.current?.pause(false);
    },
  }));

  const figure = (
    <>
      <svg
        viewBox={viewBox}
        aria-hidden="true"
        className="absolute inset-0 size-full! overflow-visible"
      >
        <ellipse
          ref={shadowRef}
          cx="80"
          cy="129"
          rx="51"
          ry="6"
          fill="light-dark(rgb(0 0 0 / 24%), rgb(0 0 0 / 65%))"
          opacity="1"
          style={{ filter: 'blur(2px)' }}
          data-testid="klex-shadow"
        />
      </svg>
      <div
        ref={actorRef}
        className="relative"
        style={{ height: avatarLayout ? size : (size * 140) / 160 }}
        data-testid="klex-actor"
      >
        <KlexSpeech speech={speech} />
        <svg
          viewBox={viewBox}
          role={children ? undefined : 'img'}
          aria-label={children ? undefined : (name ?? 'Klex')}
          aria-hidden={children ? true : undefined}
          className="block size-full! overflow-visible"
        >
          <title>{name ?? 'Klex'}</title>
          <path
            ref={bodyRef}
            d={restingBody}
            fill={color}
            data-testid="klex-body"
          />
          <g
            ref={eyesRef}
            fill={eyeColor}
            style={{ color: eyeColor }}
            transform={`translate(${80 + shape.eyeX} ${shape.eyeY})`}
            data-testid="klex-eyes"
          >
            <KlexEyes expression={reactionLook.expression ?? expression} />
            <g style={{ color }}>
              <KlexExtras
                handAnchor={handAnchor}
                paused={paused}
                transient={reactionLook.extra === 'wave'}
                extra={extrasEnabled ? (reactionLook.extra ?? extra) : 'none'}
                headTop={
                  Math.min(...shape.outline.map((point) => point[1])) -
                  shape.eyeY -
                  10
                }
              />
            </g>
          </g>
          <g
            ref={laptopRef}
            opacity="0"
            visibility={extrasEnabled ? 'visible' : 'hidden'}
            data-testid="klex-laptop"
          >
            <KlexLaptop shape={shape} />
          </g>
        </svg>
        {name ? (
          <Badge
            variant="outline"
            className="new-klex-name-badge"
            data-role={role ? '' : undefined}
            aria-hidden="true"
          >
            {name}
            {role ? <span className="new-klex-name-role">{role}</span> : null}
          </Badge>
        ) : null}
        {children}
      </div>
    </>
  );

  return (
    <div
      className={className}
      style={{ position: 'relative', flexShrink: 0, width, height: size }}
      data-layout={layout}
      data-movement={settings.mode}
    >
      {layout === 'avatar' ? (
        <div
          ref={travelRef}
          className="absolute inset-0 flex items-center justify-center"
          data-testid="klex-travel"
        >
          <div
            className="relative shrink-0"
            data-klex-figure=""
            style={{
              width: size,
              transform: `translateY(${settings.mode === 'fly' ? 64 * scale : 0}px)`,
            }}
          >
            {figure}
          </div>
        </div>
      ) : (
        <div
          ref={travelRef}
          className="absolute bottom-0 h-0"
          style={{ left: size / 2, right: size / 2 }}
          data-testid="klex-travel"
        >
          <div
            className="absolute left-1/2 -translate-x-1/2"
            data-klex-figure=""
            style={{ width: size, bottom: -12 * scale }}
          >
            {figure}
          </div>
        </div>
      )}
    </div>
  );
}
