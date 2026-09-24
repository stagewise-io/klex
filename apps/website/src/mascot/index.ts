import './mascot.css';

import { type Activity, activityProps, createActivity } from './activity';
import { type Emote, emotePose, REST_EMOTE } from './emotes';
import { getKlexEyeColor } from './geometry';
import { createGlide, type MovementMode } from './glide';
import { createIdle } from './idle';
import { type BodyShape, FAMILY_SHAPES, type MascotForm } from './presets';
import { rig } from './rig';

let instance = 0;
export type Expression =
  | 'neutral'
  | 'happy'
  | 'sleepy'
  | 'focused'
  | 'surprised';
export type { Activity, BodyShape, MovementMode };

type MascotShape = MascotForm | BodyShape;
const resolveShape = (form: MascotShape) =>
  typeof form === 'string' ? FAMILY_SHAPES[form] : form;

export function mascotMarkup(color = '#ffbd91', form: MascotShape = 'classic') {
  const id = `klex-mascot-${++instance}`;
  const state = rig(REST_EMOTE, resolveShape(form));
  const bodyColor = color
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<svg class="klex-mascot" viewBox="0 0 160 140" role="img" aria-label="Klex Bot" focusable="false">
    <title>Klex Bot</title>
    <ellipse cx="80" cy="129" rx="51" ry="3" fill="currentColor" opacity="0.12" />
    <g data-travel>
    <path data-body d="${state.path}" fill="${bodyColor}" />
    <g data-face transform="${state.face}" fill="${getKlexEyeColor(color)}" color="${getKlexEyeColor(color)}">
      ${[-9, 9]
        .map(
          (x, i) => `<g transform="translate(${x} 0)">
        <g data-eye><mask id="${id}-${i}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="20" height="20">
          <rect x="-10" y="-10" width="20" height="20" fill="white" />
          <rect data-upper x="-16" y="-20" width="32" height="20" fill="black" transform="translate(0 -10)" />
          <ellipse data-happy cy="7.5" rx="6" ry="6.5" fill="black" transform="translate(0 15)" />
        </mask><ellipse data-pupil rx="4.5" ry="6.5" mask="url(#${id}-${i})" /></g>
        <path data-closed d="M -4.5 0 H 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity="0" />
      </g>`,
        )
        .join('')}
    </g>
    <g data-laptop opacity="0" aria-hidden="true">
      <g data-laptop-anchor>
        <path d="M -38 40 H 34 L 48 56 H -30 Z" fill="#929aa9" />
        <rect x="-40" width="80" height="56" rx="4" fill="#727b8d" />
        <ellipse cx="0" cy="27" rx="5" ry="6" fill="#c7cdd7" />
      </g>
    </g>
    <g data-note opacity="0" aria-hidden="true">
      <g data-note-anchor>
        <path d="M -32 0 H 20 L 30 10 V 56 H -32 Z" fill="#fffdf7" stroke="#929aa9" stroke-width="2" />
        <path d="M 20 0 V 10 H 30" fill="none" stroke="#929aa9" stroke-width="2" />
        <ellipse cx="-33" cy="34" rx="6" ry="9" fill="${bodyColor}" />
        <g data-pencil>
          <path d="M 0 36 L 17 12" stroke="#727b8d" stroke-width="5" stroke-linecap="round" />
          <path d="M 0 36 L -3 41 L 3 38 Z" fill="#172033" />
          <ellipse cx="12" cy="26" rx="7" ry="5" fill="${bodyColor}" />
        </g>
      </g>
    </g>
    </g>
  </svg>`;
}

/** One clock per mounted mascot. Call dispose before removing its host. */
export function mountMascot(
  host: HTMLElement,
  personality: 'curious' | 'sunny' | 'shy' = 'sunny',
  form: MascotShape = 'classic',
  seed = 1,
  idleStyle: 'full' | 'breath' | 'quiet' = 'full',
) {
  const body = host.querySelector<SVGPathElement>('[data-body]');
  const face = host.querySelector<SVGGElement>('[data-face]');
  if (!body || !face) throw new Error('Klex mascot markup is missing.');
  const eyes = [...host.querySelectorAll<SVGGElement>('[data-eye]')];
  const closed = [...host.querySelectorAll<SVGPathElement>('[data-closed]')];
  const lids = [...host.querySelectorAll<SVGEllipseElement>('[data-happy]')];
  const uppers = [...host.querySelectorAll<SVGRectElement>('[data-upper]')];
  const pupils = [...host.querySelectorAll<SVGEllipseElement>('[data-pupil]')];
  const travel = host.querySelector<SVGGElement>('[data-travel]');
  const props = Object.entries(activityProps).map(([activity, prop]) => ({
    activity,
    node: host.querySelector<SVGGElement>(`[data-${prop}]`),
    anchor: host.querySelector<SVGGElement>(`[data-${prop}-anchor]`),
    scale: 0,
  }));
  const pencil = host.querySelector<SVGGElement>('[data-pencil]');
  const shape = resolveShape(form);
  const activityMotion = createActivity(seed);
  const glide = createGlide();
  let activity: Activity = 'idle';
  let expression: Expression = 'neutral';
  let gaze: { x: number; y: number } | null = null;
  let activityWeight = 0;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const idle = createIdle(seed, idleStyle);
  let frame = 0;
  let previous = 0;
  let visible = false;
  let paused = false;
  let disposed = false;
  let greeting: number | null = null;
  let gesture: Emote = 'hello';
  let gestureDuration = 2.2;
  let gestureFrom = REST_EMOTE;
  let happy = false;
  let engaged = false;
  let idleWeight = 0;
  let lastPose = REST_EMOTE;

  function render(pose = REST_EMOTE) {
    lastPose = pose;
    if (gaze && greeting === null)
      pose = { ...pose, lookX: gaze.x, lookY: gaze.y };
    if (preference.matches && activity !== 'idle')
      pose = activityMotion.pose(activity, true);
    const state = rig(
      engaged &&
        greeting === null &&
        activity === 'idle' &&
        !gaze &&
        !preference.matches
        ? {
            ...pose,
            lookX:
              personality === 'curious' ? -5 : personality === 'shy' ? 3 : 0,
            headTilt: preference.matches ? 0 : personality === 'shy' ? -4 : 2,
          }
        : {
            ...pose,
            lookX:
              pose.lookX + (form === 'box' ? -3 : form === 'classic' ? 3 : 0),
            lookY: pose.lookY + (form === 'diamond' ? -3 : 0),
          },
      shape,
    );
    travel?.setAttribute('transform', glide.transform);
    const top = Math.max(76, shape.eyeY + 20);
    for (const prop of props) {
      if (preference.matches)
        prop.scale = Number(
          activity === prop.activity && greeting === null && !glide.moving,
        );
      prop.node?.setAttribute('opacity', String(prop.scale));
      prop.anchor?.setAttribute(
        'transform',
        `translate(${98 + shape.eyeX * 0.4} ${top + (preference.matches ? 0 : activityMotion.bob)}) scale(${(Math.max(22, 120 - top) / 56) * prop.scale})`,
      );
    }
    const stroke = preference.matches ? 0 : activityMotion.writing;
    pencil?.setAttribute(
      'transform',
      `translate(${stroke * 8} ${-stroke * 3}) rotate(${stroke * 6} 12 26)`,
    );
    body?.setAttribute('d', state.path);
    face?.setAttribute('transform', state.face);
    eyes.forEach((eye, index) => {
      const blink = index === 0 ? state.pose.blinkLeft : state.pose.blinkRight;
      const open = Math.max(0, 1 - blink);
      const gaze = `translate(${state.pose.lookX} ${state.pose.lookY})`;
      eye.setAttribute('transform', `${gaze} scale(1 ${open})`);
      eye.setAttribute('opacity', String(Math.min(1, open * 4)));
      closed[index]?.setAttribute('opacity', String(1 - Math.min(1, open * 4)));
      closed[index]?.setAttribute('transform', gaze);
      lids[index]?.setAttribute(
        'transform',
        `translate(0 ${happy || expression === 'happy' || (engaged && personality === 'sunny') || (expression === 'neutral' && form === 'circle') ? 0 : 15})`,
      );
      uppers[index]?.setAttribute(
        'transform',
        `translate(0 ${expression === 'sleepy' ? 1 : expression === 'focused' ? -2 : -10}) rotate(${expression === 'focused' ? (index === 0 ? 12 : -12) : 0})`,
      );
      pupils[index]?.setAttribute(
        'rx',
        expression === 'surprised' ? '5.6' : '4.5',
      );
    });
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
  }
  function tick(now: number) {
    frame = 0;
    if (!host.isConnected) {
      dispose();
      return;
    }
    const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
    previous = now;
    glide.advance(dt);
    const resting = greeting === null && !glide.moving;
    activityMotion.advance(dt, resting ? activity : 'idle');
    activityWeight +=
      (Number(resting && activity !== 'idle') - activityWeight) *
      (1 - Math.exp(-6 * dt));
    for (const prop of props)
      prop.scale +=
        (Number(resting && activity === prop.activity) - prop.scale) *
        (1 - Math.exp(-12 * dt));
    idle.advance(dt, resting && activity === 'idle');
    const target = resting && activity === 'idle' ? 1 : 0;
    idleWeight =
      target + (idleWeight - target) * Math.exp(-dt * (target ? 2 : 10));
    const pose = idle.pose(idleWeight);
    const activityPose = activityMotion.pose(activity);
    for (const key of Object.keys(pose) as (keyof typeof pose)[])
      pose[key] += activityPose[key] * activityWeight;
    if (greeting !== null) {
      greeting += dt;
      const expression = emotePose(gesture, greeting / gestureDuration);
      const blend = Math.min(1, greeting / 0.16);
      for (const key of Object.keys(pose) as (keyof typeof pose)[]) {
        pose[key] =
          gestureFrom[key] * (1 - blend) +
          (pose[key] + expression[key]) * blend;
      }
      if (greeting >= gestureDuration) {
        greeting = null;
        happy = false;
      }
    }
    render(pose);
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    if (disposed) return;
    stop();
    if (preference.matches) {
      greeting = null;
      idleWeight = 0;
      glide.advance(0, true);
      render();
    }
    if (
      !disposed &&
      visible &&
      !paused &&
      !document.hidden &&
      !preference.matches
    )
      frame = requestAnimationFrame(tick);
  }
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  });
  observer.observe(host);
  preference.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    observer.disconnect();
    preference.removeEventListener('change', sync);
    document.removeEventListener('visibilitychange', sync);
  }
  return {
    setActivity(value: Activity) {
      if (disposed) return;
      activity = value;
      render(preference.matches ? REST_EMOTE : lastPose);
      sync();
    },
    setExpression(value: Expression) {
      if (disposed) return;
      expression = value;
      render(lastPose);
    },
    lookAt(x: number, y: number) {
      if (disposed || !Number.isFinite(x) || !Number.isFinite(y)) return;
      gaze = {
        x: Math.max(-12, Math.min(12, x)),
        y: Math.max(-12, Math.min(12, y)),
      };
      render(lastPose);
    },
    clearGaze() {
      if (disposed) return;
      gaze = null;
      render(lastPose);
    },
    cancelEmote() {
      if (disposed) return;
      greeting = null;
      happy = false;
      render(preference.matches ? REST_EMOTE : lastPose);
    },
    moveTo(target: 'left' | 'right' | number, mode?: MovementMode) {
      if (disposed) return;
      glide.moveTo(target, mode);
      sync();
    },
    setEngaged(value: boolean) {
      if (disposed) return;
      engaged = value;
      render(preference.matches ? REST_EMOTE : lastPose);
    },
    hello() {
      if (disposed || greeting !== null) return;
      gesture = 'hello';
      gestureDuration = 2.2;
      gestureFrom = lastPose;
      happy = true;
      if (!preference.matches && !paused) greeting = 0;
      render(lastPose);
      sync();
    },
    emote(kind: Emote, duration = 1.4) {
      if (disposed) return;
      gestureFrom = lastPose;
      gesture = kind;
      gestureDuration =
        Number.isFinite(duration) && duration > 0 ? duration : 1.4;
      happy = kind === 'hello' || kind === 'typing';
      greeting = preference.matches || paused ? null : 0;
      render(preference.matches ? REST_EMOTE : lastPose);
      sync();
    },
    reset() {
      if (disposed) return;
      greeting = null;
      happy = false;
      activity = 'idle';
      expression = 'neutral';
      gaze = null;
      activityWeight = 0;
      for (const prop of props) prop.scale = 0;
      glide.reset();
      render();
    },
    setPaused(value: boolean) {
      if (disposed) return;
      paused = value;
      sync();
    },
    dispose,
  };
}
