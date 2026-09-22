import './mascot.css';

import { emotePose, REST_EMOTE } from './emotes';
import { getKlexEyeColor } from './geometry';
import { createIdle } from './idle';
import { rig } from './rig';

const color = '#ffbd91'; // Cloud Peach preset, shared across light and dark themes.
let instance = 0;

export function mascotMarkup() {
  const id = `klex-mascot-${++instance}`;
  return `<svg class="klex-mascot" viewBox="0 0 160 140" role="img" aria-label="Klex Bot">
    <title>Klex Bot</title>
    <ellipse cx="80" cy="129" rx="51" ry="3" fill="currentColor" opacity="0.12" />
    <path data-body d="${rig().path}" fill="${color}" />
    <g data-face transform="${rig().face}" fill="${getKlexEyeColor(color)}" color="${getKlexEyeColor(color)}">
      ${[-9, 9]
        .map(
          (x, i) => `<g transform="translate(${x} 0)">
        <g data-eye><mask id="${id}-${i}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="20" height="20">
          <rect x="-10" y="-10" width="20" height="20" fill="white" />
          <ellipse data-happy cy="7.5" rx="6" ry="6.5" fill="black" transform="translate(0 15)" />
        </mask><ellipse rx="4.5" ry="6.5" mask="url(#${id}-${i})" /></g>
        <path data-closed d="M -4.5 0 H 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity="0" />
      </g>`,
        )
        .join('')}
    </g>
  </svg>`;
}

/** One clock per mounted mascot. Call dispose before removing its host. */
export function mountMascot(host: HTMLElement) {
  const body = host.querySelector<SVGPathElement>('[data-body]');
  const face = host.querySelector<SVGGElement>('[data-face]');
  if (!body || !face) throw new Error('Klex mascot markup is missing.');
  const eyes = [...host.querySelectorAll<SVGGElement>('[data-eye]')];
  const closed = [...host.querySelectorAll<SVGPathElement>('[data-closed]')];
  const lids = [...host.querySelectorAll<SVGEllipseElement>('[data-happy]')];
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const idle = createIdle();
  let frame = 0;
  let previous = 0;
  let visible = false;
  let paused = false;
  let disposed = false;
  let greeting: number | null = null;
  let happy = false;
  let idleWeight = 0;
  let lastPose = REST_EMOTE;

  function render(pose = REST_EMOTE) {
    lastPose = pose;
    const state = rig(pose);
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
      lids[index]?.setAttribute('transform', `translate(0 ${happy ? 0 : 15})`);
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
    idle.advance(dt, greeting === null);
    const target = greeting === null ? 1 : 0;
    idleWeight =
      target + (idleWeight - target) * Math.exp(-dt * (target ? 2 : 10));
    const pose = idle.pose(idleWeight);
    if (greeting !== null) {
      greeting += dt;
      pose.nod += emotePose('hello', greeting / 2.2).nod;
      if (greeting >= 2.2) {
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
    hello() {
      if (disposed || greeting !== null) return;
      happy = true;
      if (!preference.matches && !paused) greeting = 0;
      render(lastPose);
      sync();
    },
    setPaused(value: boolean) {
      paused = value;
      sync();
    },
    dispose,
  };
}
