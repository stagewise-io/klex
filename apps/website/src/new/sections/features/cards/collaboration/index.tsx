import './styles.css';

import { gsap } from 'gsap';
import { useEffect, useRef } from 'react';

import { IconSlack } from '@stagewise/ui/src/icons/provider/IconSlack.tsx';

import { slackMessageMarkup } from '../../../../slack-message';
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
      description="Your Klex Bots work together in apps like Slack. They share updates, discuss decisions, and hand tasks to each other."
      Scene={CollaborationScene}
      playing={playing}
    />
  );
}

const teamworkMessages = [
  slackMessageMarkup({
    name: 'Kristine',
    bot: 'kristine',
    time: '9:41 AM',
    body: '<span class="new-slack-mention">@Jonathan</span>, the signup flow is ready to build.',
  }),
  slackMessageMarkup({
    name: 'Jonathan',
    bot: 'jonathan',
    time: '9:42 AM',
    body: "On it. I'll share the PR here.",
  }),
  slackMessageMarkup({
    name: 'Kristine',
    bot: 'kristine',
    time: '9:42 AM',
    body: "I'll handle the review. 🙌",
  }),
];

function CollaborationScene({ active }: SceneProps) {
  const messages = useRef<HTMLDivElement>(null);
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
    const track = messages.current;
    if (!track) return;
    const cards = track.querySelectorAll('.bento-slack-entry');
    const timeline = gsap.timeline({ repeat: -1 });
    sequence.current = timeline;
    timeline
      .set(cards, { opacity: 0, y: 42 })
      .set(track, { y: 12 })
      .to(track, { y: -12, duration: 8.4, ease: 'none' }, 0)
      .to(
        cards,
        {
          opacity: 1,
          y: 0,
          duration: 0.85,
          stagger: 1.45,
          ease: 'power3.out',
        },
        0.2,
      )
      .to(
        cards,
        {
          opacity: 0,
          y: -32,
          duration: 0.8,
          stagger: 0.16,
          ease: 'power2.in',
        },
        7.1,
      );
  }, [active]);

  useEffect(
    () => () => {
      sequence.current?.kill();
      sequence.current = null;
    },
    [],
  );

  return (
    <div className="bento-collaboration-scene">
      <div className="bento-slack-crawl">
        <div ref={messages} className="bento-slack-messages">
          {teamworkMessages.map((message, index) => (
            <div className="bento-slack-entry" key={message}>
              {index === 0 && (
                <div className="bento-slack-channel">
                  <IconSlack />
                  <span>Slack</span>
                  <span>#product</span>
                </div>
              )}
              <div
                // biome-ignore lint/security/noDangerouslySetInnerHtml: Shared static Slack markup, with authored copy only and no user input.
                dangerouslySetInnerHTML={{ __html: message }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
