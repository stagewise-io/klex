import '../slack/slack.css';
import './report.css';

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { mascotMarkup } from '../../../mascot';
import { heroLooks } from '../../bot-looks';
import { slackConversationMarkup } from '../slack';
import { mountSlackComposer } from '../slack/composer';
import { SceneProgress } from '../workflow/controls';
import {
  PopBot,
  type PopBotHandle,
  usePlay,
  useStepPlayback,
  wait,
} from '../workflow/stage';

export const reportMarkup = `
      <section class="new-report-story" aria-labelledby="new-report-story-title">
        <div id="new-report-story"></div>
      </section>
`;

const monicaAvatar = mascotMarkup(
  heroLooks.monica.color,
  heroLooks.monica.shape,
);
const thankYouMessage = 'Amazing, thank you all!';

function MonicaAvatar() {
  return (
    <span
      className="new-slack-avatar new-slack-bot-avatar"
      aria-hidden="true"
      style={
        { '--slack-avatar-color': heroLooks.monica.color } as CSSProperties
      }
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static mascot SVG generated locally.
      dangerouslySetInnerHTML={{ __html: monicaAvatar }}
    />
  );
}

function ReportScene({
  playing,
  finished,
  onComplete,
}: {
  playing: boolean;
  finished: boolean;
  onComplete: () => void;
}) {
  const composer = useRef<HTMLDivElement>(null);
  const composerControls = useRef<ReturnType<typeof mountSlackComposer>>(null);
  const messages = useRef<HTMLDivElement>(null);
  const monica = useRef<PopBotHandle>(null);
  const [typing, setTyping] = useState(false);
  const [sent, setSent] = useState(finished);
  const [thanked, setThanked] = useState(finished);
  const [progress, setProgress] = useState(finished ? 1 : 0);

  useEffect(() => {
    if (!composer.current) return;
    const mounted = mountSlackComposer(composer.current);
    composerControls.current = mounted;
    return () => {
      composerControls.current = null;
      mounted.dispose();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: thanked adds a message, so scroll again after it renders.
  useEffect(() => {
    const panel = messages.current;
    if (!panel || !sent) return;
    panel.scrollTo({
      top: panel.scrollHeight,
      behavior:
        finished || matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
    });
  }, [sent, thanked, finished]);

  usePlay(
    playing,
    async (signal) => {
      setProgress(0.2);
      await wait(1100, signal);
      monica.current?.setActivity('working');
      monica.current?.say('Writing…');
      setTyping(true);
      setProgress(0.5);
      await wait(1800, signal);
      setTyping(false);
      setSent(true);
      setProgress(0.65);
      monica.current?.setActivity('idle');
      monica.current?.say(null);
      monica.current?.emote('happy-nod');
      await wait(1200, signal);
      for (let length = 1; length <= thankYouMessage.length; length++) {
        composerControls.current?.setDraft(thankYouMessage.slice(0, length));
        const character = thankYouMessage[length - 1];
        await wait(
          character === ','
            ? 110
            : character === ' '
              ? 65
              : 16 + Math.random() * 18,
          signal,
        );
      }
      setProgress(0.85);
      await wait(250, signal);
      composerControls.current?.setDraft('');
      setThanked(true);
      setProgress(0.95);
      await wait(900, signal);
      setProgress(1);
    },
    onComplete,
  );

  return (
    <>
      <div className="new-report-window">
        <div data-window-enter={finished ? undefined : playing}>
          <p className="new-slack-label">
            <img src="/connectors/slack.svg" alt="" width="22" height="22" />
            Slack
          </p>
          <div className="new-slack-panel">
            <div
              ref={messages}
              className="new-slack-messages"
              role="log"
              aria-label="Example conversation in Slack"
            >
              <div
                className="new-report-earlier"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: reuses the static, locally generated opening conversation.
                dangerouslySetInnerHTML={{ __html: slackConversationMarkup() }}
              />
              {sent && (
                <article className="new-slack-message new-report-message">
                  <MonicaAvatar />
                  <div>
                    <p className="new-slack-message-meta">
                      <strong>Monica</strong>
                      <span className="new-slack-bot-label">APP</span>
                      <time>4:18 PM</time>
                    </p>
                    <p>
                      <span className="new-slack-mention">@You</span>, our
                      Product Designer role is live:{' '}
                      <span className="new-report-link">
                        acme.design/careers
                      </span>
                    </p>
                    <p>
                      Listing is online, will tell you once we receive some
                      applications!
                    </p>
                    <div className="new-report-unfurl">
                      <strong>acme</strong>
                      <span className="new-report-unfurl-title">
                        Product Designer · Careers at acme
                      </span>
                      <span>
                        Design what’s next. Join a small team building better
                        ways to work.
                      </span>
                    </div>
                  </div>
                </article>
              )}
              {thanked && (
                <article className="new-slack-message new-report-message">
                  <span
                    className="new-slack-avatar new-slack-you-avatar"
                    aria-hidden="true"
                  >
                    Y
                  </span>
                  <div>
                    <p className="new-slack-message-meta">
                      <strong>You</strong>
                      <time>4:19 PM</time>
                    </p>
                    <p>{thankYouMessage}</p>
                  </div>
                </article>
              )}
            </div>
            <div
              ref={composer}
              className="new-slack-composer dark"
              inert
              aria-hidden="true"
            />
            <p
              className="new-slack-typing"
              aria-hidden="true"
              style={{ visibility: typing ? 'visible' : 'hidden' }}
            >
              Monica is typing<span>…</span>
            </p>
          </div>
        </div>
        <PopBot
          visible
          ref={monica}
          bot="monica"
          className="new-report-monica"
          speech="left"
        />
      </div>
      <SceneProgress progress={progress} />
    </>
  );
}

function ReportStory() {
  const { host, run, playing, finished, onComplete } = useStepPlayback();
  return (
    <div ref={host}>
      <ReportScene
        key={run}
        playing={playing}
        finished={finished}
        onComplete={onComplete}
      />
    </div>
  );
}

export function mountReport() {
  const host = document.getElementById('new-report-story');
  if (!host) throw new Error('The report story container is missing.');
  const root = createRoot(host);
  root.render(<ReportStory />);
  return () => root.unmount();
}
