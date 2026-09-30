import './styles.css';

import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';

import { IconGithub } from '@stagewise/ui/src/icons/nucleo/social-media/IconGithub.tsx';
import { IconDiscord } from '@stagewise/ui/src/icons/provider/IconDiscord.tsx';

import { Klex, type KlexHandle } from '../../../../klex';
import {
  type CardProps,
  FeatureCard,
  type SceneProps,
} from '../../shared/feature-card';
import { bentoBotLook } from '../../shared/scene-bot';

export function IdentityCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="identity"
      title="Their own accounts in your tools"
      description="Each Klex Bot has its own account and profile in Slack, Discord, GitHub, and the other tools your team uses."
      Scene={IdentityScene}
      playing={playing}
    />
  );
}

const accounts = [
  { provider: 'slack', handle: '@klex' },
  { provider: 'discord', handle: '@klex.bot' },
  { provider: 'github', handle: '@klex-bot' },
] as const;
const positions = ['back', 'left', 'right'] as const;

function IdentityScene({ active }: SceneProps) {
  const ring = useRef<HTMLDivElement>(null);
  const bot = useRef<KlexHandle>(null);
  const sequence = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    const timeline = gsap.timeline({ paused: true, repeat: -1 });
    sequence.current = timeline;
    timeline.set(ring.current, { rotateY: 0 });
    // A full turn plus one slot brings a different profile to the back.
    // After three spins, the ring can loop back to zero without a visible jump.
    for (let step = 1; step <= accounts.length; step++) {
      timeline
        .to(
          ring.current,
          { rotateY: step * 480, duration: 1.35, ease: 'power3.inOut' },
          '+=3.6',
        )
        .call(() => {
          bot.current?.emote('happy-nod');
        });
    }
    return () => {
      timeline.kill();
      sequence.current = null;
    };
  }, []);

  useEffect(() => {
    if (active) {
      sequence.current?.play();
      bot.current?.resume();
    } else {
      sequence.current?.pause();
      bot.current?.pause();
    }
  }, [active]);

  return (
    <div className="bento-identity-scene">
      <div className="bento-identity-world">
        <div className="bento-identity-orbit" />
        <div ref={ring} className="bento-account-ring">
          {accounts.map(({ provider, handle }, index) => {
            const logo =
              provider === 'discord' ? (
                <IconDiscord />
              ) : provider === 'github' ? (
                <IconGithub />
              ) : (
                <img src={`/connectors/${provider}.svg`} alt="" />
              );
            return (
              <div
                className="bento-account-slot"
                data-position={positions[index]}
                key={provider}
              >
                <div className="bento-account-float" data-provider={provider}>
                  <div className="bento-account-front">
                    <div className="bento-account-banner" />
                    <div className="bento-account-avatar">
                      <Klex
                        {...bentoBotLook}
                        size={44}
                        layout="avatar"
                        idle={false}
                      />
                    </div>
                    <div className="bento-account-profile">
                      <span>Klex</span>
                      <span>{handle}</span>
                    </div>
                    <div className="bento-account-provider">{logo}</div>
                  </div>
                  <div className="bento-account-back">
                    <div className="bento-account-provider">{logo}</div>
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="bento-identity-bot">
          <Klex ref={bot} {...bentoBotLook} size={76} layout="avatar" />
        </div>
      </div>
    </div>
  );
}
