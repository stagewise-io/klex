import './slack.css';

import { slackMessageMarkup } from '../../slack-message';
import { type BotSpot, workflowActor } from '../workflow/actors';
import { reportProgress } from '../workflow/controls';
import {
  STEP_ENTER,
  STEP_FINISH,
  STEP_LEAVE,
  STEP_RESET,
} from '../workflow/stage';
import { mountSlackComposer } from './composer';
import { mountSlackMonica } from './monica';

export const slackConversationMarkup = (hidden = false) =>
  [
    slackMessageMarkup({
      className: 'new-slack-human',
      name: 'You',
      time: '9:41 AM',
      hidden,
      body: `<span class="new-slack-mention">@Monica</span>, we're looking for a Product Designer. Can you add the role to our company's website?`,
    }),
    slackMessageMarkup({
      className: 'new-slack-monica',
      bot: 'monica',
      name: 'Monica',
      time: '9:42 AM',
      hidden,
      body: `<span class="new-slack-mention">@Kristine</span>, we don't have a careers page yet. Can you create a ticket to build one with an application form? I'll get started on the copy for the job offer.`,
    }),
    slackMessageMarkup({
      className: 'new-slack-kristine',
      bot: 'kristine',
      name: 'Kristine',
      time: '9:42 AM',
      hidden,
      body: `On it. I'll create a ticket for <span class="new-slack-mention">@Jonathan</span> to build the careers page and application form.`,
    }),
  ].join('');

export const slackMarkup = `
      <section class="new-story" aria-labelledby="new-story-title">
        <div class="new-story-content">
          <div class="new-slack-scene">
            <div class="new-slack-window new-slack-entrance" data-window-enter="false">
              <p class="new-slack-label"><img src="/connectors/slack.svg" alt="" width="22" height="22" />Slack</p>
              <div class="new-slack-panel">
                <div class="new-slack-messages" role="log" aria-live="polite" aria-label="Example conversation in Slack">
                  ${slackConversationMarkup(true)}
                </div>
                <div class="new-slack-composer dark" inert aria-hidden="true"></div>
                <p class="new-slack-typing" aria-hidden="true">Monica is typing<span>…</span></p>
              </div>
            </div>
            <div class="new-slack-monica-mount" data-workflow-bot="monica"></div>
            <div class="new-slack-kristine-mount" data-workflow-bot="kristine"></div>
          </div>

        </div>
      </section>
`;

export function mountSlack() {
  const events = new AbortController();
  const story = document.querySelector<HTMLElement>('.new-story');
  if (!story) throw new Error('The Slack story is missing.');
  const entranceHost = story.querySelector<HTMLElement>('.new-slack-entrance');
  const composerContainer = story.querySelector<HTMLElement>(
    '.new-slack-composer',
  );
  const humanMessage = story.querySelector<HTMLElement>('.new-slack-human');
  const typing = story.querySelector<HTMLElement>('.new-slack-typing');
  const monicaMessage = story.querySelector<HTMLElement>('.new-slack-monica');
  const kristineMessage = story.querySelector<HTMLElement>(
    '.new-slack-kristine',
  );
  const messages = story.querySelector<HTMLElement>('.new-slack-messages');
  const slide = story.closest<HTMLElement>('.new-workflow-slide');
  const monicaHost = story.querySelector<HTMLElement>(
    '.new-slack-monica-mount',
  );
  const kristineHost = story.querySelector<HTMLElement>(
    '.new-slack-kristine-mount',
  );
  if (
    !entranceHost ||
    !composerContainer ||
    !humanMessage ||
    !typing ||
    !monicaMessage ||
    !kristineMessage ||
    !messages ||
    !slide ||
    !monicaHost ||
    !kristineHost
  ) {
    throw new Error('The Slack story markup is incomplete.');
  }
  const composer = mountSlackComposer(composerContainer);
  const monica = mountSlackMonica(monicaHost);
  const kristineHome: BotSpot = () => {
    const box = kristineHost.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.bottom, speech: 'left' };
  };
  const showKristine = (instant = false) => {
    const actor = workflowActor(kristineHost, 'kristine');
    if (instant) actor?.place(kristineHome);
    else actor?.pop(kristineHome);
  };
  const hideKristine = () => workflowActor(kristineHost, 'kristine')?.hide();

  const text =
    "@Monica, we're looking for a Product Designer. Can you add the role to our company's website?";
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let storyTimer: number | undefined;
  let completed = false;
  let started = false;
  const later = (callback: () => void, delay: number) => {
    storyTimer = window.setTimeout(callback, delay);
  };

  const completeStory = () => {
    completed = true;
    reportProgress(slide, 1);
  };

  const finishStory = () => {
    window.clearTimeout(storyTimer);
    delete entranceHost.dataset.windowEnter;
    composer.setDraft('');
    humanMessage.hidden = false;
    monicaMessage.hidden = false;
    kristineMessage.hidden = false;
    messages.scrollTop = messages.scrollHeight;
    typing.style.visibility = 'hidden';
    monica.setPhase('done');
    if (slide.getAttribute('aria-hidden') !== 'true') showKristine(true);
    completeStory();
  };

  const playStory = () => {
    started = true;
    window.clearTimeout(storyTimer);
    completed = false;
    reportProgress(slide, 0);
    composer.setDraft('');
    humanMessage.hidden = true;
    monicaMessage.hidden = true;
    kristineMessage.hidden = true;
    messages.scrollTop = 0;
    typing.style.visibility = 'hidden';
    if (typing.firstChild) typing.firstChild.textContent = 'Monica is typing';
    monica.setPhase('hidden');
    hideKristine();

    if (reducedMotion.matches) {
      finishStory();
      return;
    }

    entranceHost.dataset.windowEnter = 'false';
    // Commit the reset so replay restarts the CSS animation on the same window.
    entranceHost.getBoundingClientRect();
    entranceHost.dataset.windowEnter = 'true';
    reportProgress(slide, 0.02);

    let length = 0;
    let wordPace = 18;
    const typeNext = () => {
      composer.setDraft(text.slice(0, ++length));
      reportProgress(slide, 0.05 + (0.45 * length) / text.length);
      if (length < text.length) {
        const character = text[length - 1];
        if (character === ' ') wordPace = 10 + Math.random() * 16;
        let delay = wordPace * (0.6 + Math.random() * 0.8);
        if (character === ' ') delay += 20 + Math.random() * 30;
        else if (character === ',') delay += 70 + Math.random() * 40;
        else if (/[.!?]/.test(character)) delay += 140 + Math.random() * 60;
        later(typeNext, delay);
        return;
      }

      later(() => {
        composer.setDraft('');
        humanMessage.hidden = false;
        reportProgress(slide, 0.55);
        monica.setPhase('replying');
        typing.style.visibility = 'visible';
        later(() => {
          typing.style.visibility = 'hidden';
          monicaMessage.hidden = false;
          messages.scrollTop = messages.scrollHeight;
          monica.setPhase('working');
          showKristine();
          reportProgress(slide, 0.65);
          later(() => {
            workflowActor(kristineHost, 'kristine')?.setActivity('working');
            workflowActor(kristineHost, 'kristine')?.say('Writing…');
            if (typing.firstChild)
              typing.firstChild.textContent = 'Kristine is typing';
            typing.style.visibility = 'visible';
            later(() => {
              typing.style.visibility = 'hidden';
              kristineMessage.hidden = false;
              workflowActor(kristineHost, 'kristine')?.setActivity('idle');
              workflowActor(kristineHost, 'kristine')?.say(null);
              workflowActor(kristineHost, 'kristine')?.emote('happy-nod');
              messages.scrollTop = messages.scrollHeight;
              reportProgress(slide, 0.85);
              later(() => {
                monica.setPhase('done');
                completeStory();
              }, 2400);
            }, 1800);
          }, 2200);
        }, 1600);
      }, 250);
    };

    later(typeNext, 650);
  };

  reducedMotion.addEventListener(
    'change',
    ({ matches }) => {
      if (matches && started && !completed) finishStory();
    },
    { signal: events.signal },
  );

  slide.addEventListener(
    STEP_ENTER,
    () => {
      if (!completed) playStory();
      else showKristine(true);
    },
    { signal: events.signal },
  );
  slide.addEventListener(STEP_FINISH, finishStory, { signal: events.signal });
  slide.addEventListener(
    STEP_RESET,
    () => {
      window.clearTimeout(storyTimer);
      entranceHost.dataset.windowEnter = 'false';
      humanMessage.hidden = true;
      monicaMessage.hidden = true;
      kristineMessage.hidden = true;
      typing.style.visibility = 'hidden';
      composer.setDraft('');
      monica.setPhase('hidden');
      hideKristine();
      started = false;
      completed = false;
      reportProgress(slide, 0);
    },
    { signal: events.signal },
  );
  slide.addEventListener(
    STEP_LEAVE,
    () => {
      if (started && !completed) finishStory();
      workflowActor(kristineHost, 'kristine')?.rest();
    },
    { signal: events.signal },
  );

  return () => {
    events.abort();
    window.clearTimeout(storyTimer);
    composer.dispose();
    monica.dispose();
  };
}
