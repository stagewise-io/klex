import './styles.css';

import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';

import { Klex, type KlexHandle } from '../../../../klex';
import { DEFAULT_GLIDE, MOVEMENT_STYLES } from '../../../../klex/presets';
import {
  type CardProps,
  FeatureCard,
  type SceneProps,
} from '../../shared/feature-card';
import { bentoBotLook } from '../../shared/scene-bot';

export function ToolsCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="tools"
      title="Right where work happens"
      description="Slack conversations. Linear tickets. GitHub pull requests. Klex Bots work in the tools you use."
      Scene={ToolsScene}
      playing={playing}
    />
  );
}

const tools = [
  { tool: 'slack', height: 0 },
  { tool: 'linear', height: -30 },
  { tool: 'github', height: -12 },
  { tool: 'teams', height: -24 },
  { tool: 'jira', height: -8 },
  { tool: 'notion', height: -30 },
  { tool: 'whatsapp', height: 0 },
  { tool: 'gmail', height: -12 },
];
const toolStep = 100;
const toolCycle = tools.length * toolStep;
// Five extra blocks at either end keep the conveyor filled around its loop seam.
// The first Slack block remains aligned with the bot at the scene's center.
const toolBlocks = Array.from({ length: tools.length + 10 }, (_, index) => ({
  id: `tool-${index}`,
  ...tools[(index - 5 + tools.length) % tools.length],
}));
const toolBotSettings = {
  ...(MOVEMENT_STYLES.find((style) => style.id === 'fly')?.settings ??
    DEFAULT_GLIDE),
  speed: 320,
};

function ToolsScene({ active }: SceneProps) {
  const bot = useRef<KlexHandle>(null);
  const conveyor = useRef<HTMLDivElement>(null);
  const carrier = useRef<HTMLDivElement>(null);
  const travel = useRef({ distance: 0, origin: 0, platform: 0, moving: false });

  useEffect(() => {
    const belt = conveyor.current;
    const frame = carrier.current;
    if (!belt || !frame) return;
    if (!active) {
      bot.current?.pause();
      return;
    }
    bot.current?.resume();
    const tick = (_time: number, deltaMs: number) => {
      const state = travel.current;
      // Share the rig's elapsed-time cap so dropped frames cannot desync the feet.
      // Never carry the bot past the next platform while it catches up.
      state.distance = Math.min(
        state.distance + Math.min(deltaMs / 1000, 0.05) * (toolStep / 1.8),
        state.origin + toolStep,
      );
      belt.style.transform = `translateX(${-state.distance % toolCycle}px)`;
      frame.style.transform = `translateX(${state.origin - state.distance}px)`;
      if (!state.moving && state.distance - state.origin >= 40) {
        state.moving = true;
        bot.current?.moveTo({
          x: 50,
          y: tools[(state.platform + 1) % tools.length].height,
        });
      }
    };
    gsap.ticker.add(tick);
    return () => {
      gsap.ticker.remove(tick);
      bot.current?.pause();
    };
  }, [active]);

  const land = () => {
    const state = travel.current;
    if (!state.moving) return;
    state.platform = (state.platform + 1) % tools.length;
    state.origin += toolStep;
    state.moving = false;
    // Rebase on arrival. Waiting for the final settling animation lets the
    // conveyor carry the bot away between flights.
    bot.current?.snapTo({ x: 0, y: tools[state.platform].height });
    carrier.current?.style.setProperty(
      'transform',
      `translateX(${state.origin - state.distance}px)`,
    );
  };

  return (
    <div className="bento-tools-scene">
      <div ref={conveyor} className="bento-tool-conveyor">
        {toolBlocks.map(({ id, tool, height }) => (
          <div
            key={id}
            className="bento-tool-block"
            data-tool={tool}
            style={{ transform: `translateY(${height}px)` }}
          >
            <div className="bento-tool-block-face">
              <img src={`/connectors/${tool}.svg`} alt="" />
            </div>
          </div>
        ))}
      </div>
      <div ref={carrier} className="bento-tools-runner">
        <Klex
          ref={bot}
          {...bentoBotLook}
          settings={toolBotSettings}
          size={54}
          width={254}
          layout="track"
          onMoveArrival={land}
        />
      </div>
    </div>
  );
}
