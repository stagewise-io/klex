import './styles.css';

import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';

import { IconDiscord } from '@stagewise/ui/src/icons/provider/IconDiscord.tsx';
import { IconSlack } from '@stagewise/ui/src/icons/provider/IconSlack.tsx';

import { mascotMarkup } from '../../../../../mascot';
import { heroLooks } from '../../../../bot-looks';
import {
  type CardProps,
  FeatureCard,
  type SceneProps,
} from '../../shared/feature-card';

export function CollaborationCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="collaboration"
      title="Teamwork comes naturally"
      description="Your Klex Bots work together in apps like Slack, Teams or Discord (or anywhere else!). They share updates, discuss decisions, and hand tasks to each other."
      Scene={CollaborationScene}
      playing={playing}
    />
  );
}

const teamworkApps = [
  { id: 'slack', name: 'Slack', channel: '#product', badge: 'APP' },
  { id: 'teams', name: 'Teams', channel: 'Product / General', badge: 'APP' },
  { id: 'discord', name: 'Discord', channel: '#product', badge: 'BOT' },
] as const;

const teamworkMessages = [
  {
    id: 'handoff',
    name: 'Kristine',
    bot: 'kristine',
    time: '9:41 AM',
    body: (
      <>
        <span className="bento-chat-mention">@Jonathan</span>, the signup flow
        is ready to build.
      </>
    ),
  },
  {
    id: 'accept',
    name: 'Jonathan',
    bot: 'jonathan',
    time: '9:42 AM',
    body: "On it. I'll share the PR here.",
  },
  {
    id: 'review',
    name: 'Kristine',
    bot: 'kristine',
    time: '9:42 AM',
    body: "I'll handle the review. 🙌",
  },
] as const;

// Each avatar needs its own SVG mask IDs, including repeated bots in other apps.
const teamworkConversations = teamworkApps.map((app) => ({
  ...app,
  messages: teamworkMessages.map((message) => ({
    ...message,
    avatar: mascotMarkup(
      heroLooks[message.bot].color,
      heroLooks[message.bot].shape,
    ),
  })),
}));
const conversationDuration = 8.4;

function CollaborationScene({ active }: SceneProps) {
  const scene = useRef<HTMLDivElement>(null);
  const sequence = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    if (!active) {
      sequence.current?.pause();
      return;
    }
    if (sequence.current) {
      sequence.current.play();
      return;
    }
    const host = scene.current;
    if (!host) return;
    const panels = host.querySelectorAll('.bento-chat-panel');
    const timeline = gsap.timeline({ repeat: -1, paused: true });
    sequence.current = timeline;
    timeline.set(panels, { autoAlpha: 0 });
    panels.forEach((panel, index) => {
      const cards = panel.querySelectorAll('.bento-chat-message');
      const start = index * conversationDuration;
      timeline
        .set(cards, { opacity: 0, y: 24 }, start)
        .to(panel, { autoAlpha: 1, duration: 0.35 }, start)
        .to(
          cards,
          {
            opacity: 1,
            y: 0,
            duration: 0.85,
            stagger: 1.45,
            ease: 'power3.out',
          },
          start + 0.2,
        )
        .to(
          cards,
          {
            opacity: 0,
            y: -16,
            duration: 0.6,
            stagger: 0.16,
            ease: 'power2.in',
          },
          start + 7.1,
        )
        .to(panel, { autoAlpha: 0, duration: 0.45 }, start + 7.95);
    });
    timeline.play();
  }, [active]);

  useEffect(
    () => () => {
      sequence.current?.kill();
      sequence.current = null;
    },
    [],
  );

  return (
    <div ref={scene} className="bento-collaboration-scene">
      <div className="bento-chat-crawl">
        {teamworkConversations.map((app) => (
          <div className="bento-chat-panel" data-app={app.id} key={app.id}>
            <div className="bento-chat-channel">
              {app.id === 'slack' ? (
                <IconSlack />
              ) : app.id === 'discord' ? (
                <IconDiscord />
              ) : (
                <img src="/connectors/teams.svg" alt="" />
              )}
              <span>{app.name}</span>
              <span>{app.channel}</span>
            </div>
            <div className="bento-chat-messages">
              {app.messages.map((message) => (
                <article className="bento-chat-message" key={message.id}>
                  <span
                    className="bento-chat-avatar"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${heroLooks[message.bot].color} 18%, var(--chat-surface))`,
                    }}
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: Static mascot SVG generated from authored bot looks, never user input.
                    dangerouslySetInnerHTML={{
                      __html: message.avatar,
                    }}
                  />
                  <div className="bento-chat-content">
                    <div className="bento-chat-meta">
                      <strong>{message.name}</strong>
                      <span className="bento-chat-badge">{app.badge}</span>
                      <time>{message.time}</time>
                    </div>
                    <p>{message.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
