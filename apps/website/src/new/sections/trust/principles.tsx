import './principles.css';

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { heroLooks } from '../../bot-looks';
import { Klex, type KlexHandle } from '../../klex';
import { BODY_SHAPES } from '../../klex/presets';
import { mountOffice } from './office-team';

/** Each miniature runs only while it is visible, on an active page. */
function useScenePlayback() {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) =>
        setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.15),
      { threshold: 0.15 },
    );
    observer.observe(element);
    const onVisibility = () => setPageVisible(!document.hidden);
    const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionPreference = () => setReducedMotion(motionPreference.matches);
    motionPreference.addEventListener('change', onMotionPreference);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      motionPreference.removeEventListener('change', onMotionPreference);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return {
    host,
    active: visible && pageVisible && !reducedMotion,
    reducedMotion,
  };
}

const hostingBots = [
  { id: 'jonathan', look: heroLooks.jonathan, size: 36 },
  { id: 'monica', look: heroLooks.monica, size: 34 },
  { id: 'kristine', look: heroLooks.kristine, size: 36 },
  { id: 'jeff', look: heroLooks.jeff, size: 34 },
  {
    id: 'harry',
    look: { color: '#a7cbb6', shape: heroLooks.jeff.shape },
    size: 36,
  },
];

const hostingStops = [-35, 0, 35];

function HostingScene() {
  const { host, active } = useScenePlayback();
  const bots = useRef<(KlexHandle | null)[]>([]);

  useEffect(() => {
    for (const bot of bots.current) {
      if (active) bot?.resume();
      else bot?.pause();
    }
    if (!active) return;
    let step = 1;
    const timers = new Set<number>();
    const travel = () => {
      hostingBots.forEach((_, index) => {
        const destination = (step + index) % hostingStops.length;
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          bots.current[index]?.moveTo({
            x: hostingStops[destination] + (index % 2 === 0 ? -4 : 4),
            y: destination === 1 ? -18 : 0,
          });
        }, index * 160);
        timers.add(timer);
      });
      step++;
    };
    const timer = window.setInterval(travel, 3400);
    return () => {
      window.clearInterval(timer);
      for (const pending of timers) window.clearTimeout(pending);
    };
  }, [active]);

  return (
    <div ref={host} className="trust-scene trust-hosting" data-active={active}>
      <svg
        className="trust-hosting-hardware"
        viewBox="0 0 360 240"
        aria-hidden="true"
      >
        <path
          className="trust-hosting-route"
          d="M58 181 Q118 193 180 166 Q242 193 302 181"
        />
        <g className="trust-hosting-machine">
          <path
            className="trust-hardware-top"
            d="M23 120 36 108h52l13 12v7H23Z"
          />
          <rect x="23" y="120" width="78" height="15" rx="4" />
          <path className="trust-hardware-detail" d="M40 127h18 M70 127h6" />
          <circle className="trust-hardware-led" cx="89" cy="127" r="1.8" />
        </g>
        <g className="trust-hosting-machine">
          <rect x="145" y="59" width="57" height="43" rx="4" />
          <rect
            className="trust-hardware-screen"
            x="150"
            y="64"
            width="47"
            height="32"
            rx="1"
          />
          <path
            className="trust-screen-code"
            d="m158 75 4 4-4 4 m9 0h12 m-12-10h19"
          />
          <path className="trust-hardware-detail" d="M173 102v11 M162 113h22" />
          <rect x="211" y="75" width="20" height="38" rx="3" />
          <path className="trust-hardware-detail" d="M216 83h10 M216 88h10" />
          <circle className="trust-hardware-led" cx="221" cy="103" r="2" />
          <path
            className="trust-company-desk"
            d="M134 119h104 M142 119v18 M230 119v18"
          />
        </g>
        <g className="trust-hosting-machine">
          <rect x="269" y="57" width="63" height="81" rx="5" />
          {[65, 86, 107].map((y) => (
            <g key={y}>
              <rect
                className="trust-hardware-top"
                x="276"
                y={y}
                width="49"
                height="16"
                rx="2"
              />
              <path
                className="trust-hardware-detail"
                d={`M282 ${y + 5}h19 M282 ${y + 10}h19`}
              />
              <circle
                className="trust-hardware-led"
                cx="317"
                cy={y + 8}
                r="2"
              />
            </g>
          ))}
          <path className="trust-hardware-detail" d="M280 138v5 M321 138v5" />
          <path
            className="trust-hosting-cloud"
            d="M279 44h42a7 7 0 0 0-1-14 11 11 0 0 0-21-4 8 8 0 0 0-13 7 6 6 0 0 0-7 11Z"
          />
        </g>
        <g className="trust-hosting-labels">
          <text x="62" y="221">
            Self hosted
          </text>
          <text x="181" y="221">
            On-Premise
          </text>
          <text x="300" y="221">
            Managed Cloud
          </text>
        </g>
      </svg>
      {hostingBots.map((bot, index) => (
        <div
          className="trust-hosting-track"
          key={bot.id}
          style={{ top: 140 + (index % 2) * 14 }}
        >
          <Klex
            ref={(handle) => {
              bots.current[index] = handle;
            }}
            {...bot.look}
            className={
              bot.id === 'jeff' ? 'trust-hosting-white-bot' : undefined
            }
            size={bot.size}
            movementMode={bot.id === 'jonathan' ? 'fly' : 'hop'}
            width="100%"
            initialPosition={{
              x:
                hostingStops[index % hostingStops.length] +
                (index % 2 === 0 ? -4 : 4),
              y: index % hostingStops.length === 1 ? -18 : 0,
            }}
          />
        </div>
      ))}
    </div>
  );
}

const wires = [
  { app: 'teams', x: 34, y: 54, path: 'M128 88 C92 88 105 54 34 54' },
  { app: 'github', x: 326, y: 54, path: 'M232 88 C268 88 255 54 326 54' },
  { app: 'linear', x: 34, y: 185, path: 'M128 150 C82 150 100 185 34 185' },
  { app: 'outlook', x: 326, y: 185, path: 'M232 150 C278 150 260 185 326 185' },
];

const defaultKlexLook = {
  color: '#2559fe',
  shape: BODY_SHAPES[0],
  movementMode: 'fly',
} as const;

function IsolationScene() {
  const { host, active } = useScenePlayback();
  const bot = useRef<KlexHandle>(null);
  useEffect(() => {
    if (active) bot.current?.resume();
    else bot.current?.pause();
  }, [active]);

  return (
    <div
      ref={host}
      className="trust-scene trust-isolation"
      data-active={active}
    >
      <svg className="trust-orb-wires" viewBox="0 0 360 240" aria-hidden="true">
        {wires.map((wire, index) => (
          <g key={wire.app}>
            <path className="trust-wire" d={wire.path} />
            <path
              className="trust-wire-signal"
              d={wire.path}
              style={{ animationDelay: `${index * -0.8}s` }}
            />
            <rect
              className="trust-wire-port"
              x={wire.x - 15}
              y={wire.y - 15}
              width="30"
              height="30"
              rx="7"
            />
            <image
              href={`/connectors/${wire.app}.svg`}
              x={wire.x - 9}
              y={wire.y - 9}
              width="18"
              height="18"
            />
          </g>
        ))}
      </svg>
      <div className="trust-orb">
        <div className="trust-orb-bot">
          <Klex ref={bot} {...defaultKlexLook} size={100} layout="avatar" />
        </div>
      </div>
    </div>
  );
}

function MemoryScene() {
  const { host, active, reducedMotion } = useScenePlayback();
  const bot = useRef<KlexHandle>(null);
  const [stage, setStage] = useState(0);
  const age = reducedMotion ? 2 : stage;

  useEffect(() => {
    bot.current?.setExtra(age === 0 ? 'blush' : 'none');
    if (active) bot.current?.resume();
    else bot.current?.pause();
    if (!active || stage === 2) return;
    const timer = window.setTimeout(() => setStage((value) => value + 1), 3600);
    return () => window.clearTimeout(timer);
  }, [active, age, stage]);

  return (
    <div
      ref={host}
      className="trust-scene trust-memory"
      data-active={active}
      data-age={age}
    >
      <div className="trust-memory-record">
        <span className="trust-memory-record-label">Memory</span>
        {[68, 88, 58, 82, 72, 45].map((width, index) => (
          <span
            key={width}
            className="trust-memory-line"
            data-added={index < [1, 3, 6][age]}
            style={{
              width: `${width}%`,
              transitionDelay: `${(index % 3) * 100}ms`,
            }}
          />
        ))}
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m4 10 4 4 8-8" />
        </svg>
      </div>
      <div className="trust-memory-bot">
        <Klex
          ref={bot}
          {...defaultKlexLook}
          size={120}
          layout="avatar"
          idle={false}
          activity={age === 2 ? 'working' : 'idle'}
          initialExtra="blush"
        >
          <svg
            className="trust-baby-details"
            viewBox="0 -10 160 160"
            aria-hidden="true"
          >
            <g
              transform={`translate(${80 + defaultKlexLook.shape.eyeX} ${defaultKlexLook.shape.eyeY})`}
            >
              <path
                className="trust-baby-curl"
                d="M-3-43c-10-9 4-18 9-10c3 5-3 8-5 4"
              />
              <ellipse
                className="trust-baby-pacifier"
                cx="0"
                cy="17"
                rx="14"
                ry="9"
              />
              <circle
                className="trust-baby-pacifier-center"
                cx="0"
                cy="17"
                r="4"
              />
              <circle
                className="trust-baby-pacifier-ring"
                cx="0"
                cy="25"
                r="6"
              />
            </g>
          </svg>
          <svg
            className="trust-mature-details"
            viewBox="0 -10 160 160"
            aria-hidden="true"
          >
            <g
              transform={`translate(${80 + defaultKlexLook.shape.eyeX} ${defaultKlexLook.shape.eyeY})`}
            >
              <g className="trust-mature-glasses">
                <rect x="-24" y="-10" width="21" height="20" rx="6" />
                <rect x="3" y="-10" width="21" height="20" rx="6" />
                <path d="M-3-2 Q0-5 3-2 M-24-3h-5 M24-3h5" />
              </g>
              <path
                className="trust-mature-silver"
                d="M-22-16q7-5 13-1 M9-17q7-4 13 1 M-13 15q7-8 13-2q6-6 13 2"
              />
            </g>
          </svg>
        </Klex>
      </div>
      <div className="trust-memory-timeline">
        {['First day', 'Update 01', 'Update 02'].map((label, index) => (
          <span
            key={label}
            data-reached={index <= age}
            data-current={index === age}
          >
            <i />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function mountTrust() {
  const disposeOffice = mountOffice();
  const scenes = {
    open: HostingScene,
    isolated: IsolationScene,
    memory: MemoryScene,
  };
  const roots = Object.entries(scenes).flatMap(([id, Scene]) => {
    const host = document.querySelector<HTMLElement>(
      `[data-trust-scene="${id}"]`,
    );
    if (!host) return [];
    const root = createRoot(host);
    root.render(<Scene />);
    return [root];
  });
  return () => {
    disposeOffice();
    for (const root of roots) root.unmount();
  };
}
