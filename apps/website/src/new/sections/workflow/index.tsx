import './window.css';
import './workflow.css';

import { flushSync } from 'react-dom';

import { mountWorkflowActors } from './actors';
import { mountWorkflowControls, reportProgress } from './controls';
import { STEP_ENTER, STEP_FINISH, STEP_LEAVE, STEP_RESET } from './stage';
import {
  mountWorkflowTitleAvatars,
  workflowTitleMarkup,
} from './title-avatars';

const steps = [
  {
    id: 'new-story-title',
    phase: 'Request',
    title: 'You need to hire a product designer.',
    description:
      'You’re hiring a Product Designer. In Slack, your team asks Monica to add that to the company’s website. Monica starts writing the job-offer copy.',
  },
  {
    id: 'new-build-story-title',
    phase: 'Plan & build',
    title: 'Kristine plans. Jonathan builds the page',
    description:
      'Kristine creates a ticket in Linear and assigns it to Jonathan. He then writes the careers page and application form, checks it in the browser, and opens a pull request.',
  },
  {
    id: 'new-pr-story-title',
    phase: 'Test & fix',
    title: 'Jeff finds a bug. Jonathan fixes it',
    description:
      'Jeff, your QA Klex Bot, tests the application and reports a bug on the pull request. Jonathan fixes it. Jeff retests and approves, then the page is merged and deployed.',
  },
  {
    id: 'new-report-story-title',
    phase: 'Report back',
    title: 'Monica reports back',
    description:
      'The listing is online. Monica shares the link in Slack and will let you know when applications arrive.',
  },
];

export const workflowMarkup = (panels: string[]) => `
  <section class="new-workflow" id="how-it-works" aria-labelledby="new-workflow-intro">
    <div class="new-workflow-viewport">
      <div class="new-workflow-body">
        <div class="new-workflow-navigation" role="group" aria-label="Workflow steps">
          <h2 class="new-workflow-intro" id="new-workflow-intro">How Klex Bots work together</h2>
          <div class="new-workflow-mobile-steps" aria-label="Choose a story step">
            ${steps.map(({ phase }, index) => `<button type="button" data-step="${index}" aria-label="Step ${index + 1}: ${phase}" aria-controls="new-workflow-panel-${index}" aria-current="${index === 0 ? 'step' : 'false'}">${String(index + 1).padStart(2, '0')}</button>`).join('')}
          </div>
          <div class="new-workflow-step-viewport">
          <ol class="new-workflow-steps">
            ${steps
              .map(
                ({ id, phase, title, description }, index) => `
              <li class="new-workflow-step" data-active="${index === 0}">
                <h3 id="${id}">
                  <button class="new-workflow-step-button" type="button" data-step="${index}" aria-controls="new-workflow-panel-${index}" aria-current="${index === 0 ? 'step' : 'false'}">
                    <span class="new-workflow-step-number"><span class="new-workflow-step-index">${String(index + 1).padStart(2, '0')}</span> · ${phase}</span>
                    ${workflowTitleMarkup(title)}
                  </button>
                </h3>
                <div class="new-workflow-description" aria-hidden="${index !== 0}"${index === 0 ? '' : ' inert'}><div>
                  <p>${description}</p>
                  <div class="new-workflow-controls-slot">${index === 0 ? '<div class="new-workflow-controls-mount"></div>' : ''}</div>
                </div>
                </div>
              </li>
            `,
              )
              .join('')}
          </ol>
          </div>
        </div>
        <div class="new-workflow-scenes" role="group" aria-label="Workflow illustrations">
          <div class="new-workflow-track">
            ${panels.map((panel, index) => `<div class="new-workflow-slide" id="new-workflow-panel-${index}"${index === 0 ? '' : ' inert aria-hidden="true"'}><div class="new-workflow-artwork">${panel}</div></div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </section>
`;

export function mountWorkflow() {
  const viewport = document.querySelector<HTMLElement>(
    '.new-workflow-viewport',
  );
  const scenes = viewport?.querySelector<HTMLElement>('.new-workflow-scenes');
  const track = viewport?.querySelector<HTMLElement>('.new-workflow-track');
  const navigation = viewport?.querySelector<HTMLElement>(
    '.new-workflow-navigation',
  );
  const slides = Array.from(
    viewport?.querySelectorAll<HTMLElement>('.new-workflow-slide') ?? [],
  );
  const entries = Array.from(
    viewport?.querySelectorAll<HTMLElement>('.new-workflow-step') ?? [],
  ).map((element) => {
    const heading = element.querySelector<HTMLButtonElement>(
      '.new-workflow-step-button',
    );
    const description = element.querySelector<HTMLElement>(
      '.new-workflow-description',
    );
    if (!heading || !description)
      throw new Error('A workflow step is incomplete.');
    return { element, heading, description };
  });
  const artwork = Array.from(
    viewport?.querySelectorAll<HTMLElement>('.new-workflow-artwork') ?? [],
  );
  if (
    !viewport ||
    !scenes ||
    !track ||
    !navigation ||
    slides.length !== steps.length
  ) {
    throw new Error('The workflow markup is incomplete.');
  }

  viewport.style.setProperty('--workflow-count', String(slides.length));
  const actors = mountWorkflowActors(track);
  const disposeTitleAvatars = mountWorkflowTitleAvatars(navigation);
  let activeStep = -1;
  let started = false;
  const controls = mountWorkflowControls(
    viewport,
    slides,
    () => {
      entries[activeStep].heading.focus({ preventScroll: true });
      jumpToStep(activeStep);
    },
    () => {
      if (
        slides[activeStep]?.dataset.progress === '1' &&
        activeStep < slides.length - 1
      ) {
        setStep(activeStep + 1);
      }
    },
    () => {
      entries[activeStep].heading.focus({ preventScroll: true });
      jumpToStep(0);
    },
  );
  const visibility = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      started = true;
      slides[activeStep]?.dispatchEvent(new Event(STEP_ENTER));
      visibility.disconnect();
    },
    { threshold: 0.6 },
  );
  visibility.observe(viewport);

  const setStep = (index: number, skipArrival = false) => {
    const next = Math.max(0, Math.min(index, slides.length - 1));
    const moveFocus = viewport.contains(document.activeElement);
    slides[activeStep]?.dispatchEvent(new Event(STEP_LEAVE));
    activeStep = next;
    viewport.style.setProperty('--workflow-step', String(next));
    viewport.style.setProperty(
      '--workflow-offset',
      `calc(${-next} * (var(--workflow-scene-height, 0px) - var(--workflow-overlap)))`,
    );
    for (const [step, slide] of slides.entries()) {
      const active = step === next;
      slide.inert = !active;
      slide.dataset.past = String(step < next);
      slide.setAttribute('aria-hidden', String(!active));
    }
    for (const [step, { element, heading, description }] of entries.entries()) {
      const active = step === next;
      element.dataset.active = String(active);
      description.inert = !active;
      description.setAttribute('aria-hidden', String(!active));
      heading.setAttribute('aria-current', active ? 'step' : 'false');
      heading.tabIndex =
        matchMedia('(max-width: 1024px)').matches && !active ? -1 : 0;
    }
    for (const button of navigation.querySelectorAll<HTMLButtonElement>(
      '.new-workflow-mobile-steps button',
    )) {
      button.setAttribute(
        'aria-current',
        Number(button.dataset.step) === next ? 'step' : 'false',
      );
    }
    if (started) {
      slides[next].dispatchEvent(
        new CustomEvent(STEP_ENTER, { detail: { skipArrival } }),
      );
    }
    controls.setStep(next);
    viewport.style.setProperty(
      '--workflow-step-height',
      `${entries[next].element.offsetHeight}px`,
    );
    if (moveFocus) entries[next].heading.focus({ preventScroll: true });
  };

  const jumpToStep = (next: number) => {
    visibility.disconnect();
    started = true;
    viewport.dataset.jumping = 'true';
    slides[activeStep]?.dispatchEvent(new Event(STEP_LEAVE));
    // Keep remount effects from restoring the old active scene's actors.
    for (const slide of slides) slide.setAttribute('aria-hidden', 'true');
    flushSync(() => {
      for (const [index, slide] of slides.entries()) {
        slide.dispatchEvent(new Event(index < next ? STEP_FINISH : STEP_RESET));
        reportProgress(slide, index < next ? 1 : 0);
      }
    });
    actors.reset();
    // Finished scenes restore their actors in story order, without playing.
    for (const slide of slides.slice(0, next)) {
      flushSync(() => slide.dispatchEvent(new Event(STEP_ENTER)));
    }
    flushSync(() => setStep(next, true));
    // Commit the jump before restoring transitions for normal Next playback.
    track.getBoundingClientRect();
    delete viewport.dataset.jumping;
  };
  const clicks = new AbortController();
  for (const button of navigation.querySelectorAll<HTMLButtonElement>(
    '[data-step]',
  )) {
    button.addEventListener(
      'click',
      () => jumpToStep(Number(button.dataset.step)),
      {
        signal: clicks.signal,
      },
    );
  }

  // Mobile reserves the tallest scaled illustration so steps don't shift the section.
  const resize = new ResizeObserver(() => {
    const mobile = matchMedia('(max-width: 1024px)').matches;
    viewport.style.setProperty(
      '--workflow-step-height',
      `${entries[activeStep].element.offsetHeight}px`,
    );
    for (const [index, { heading }] of entries.entries()) {
      heading.tabIndex = mobile && index !== activeStep ? -1 : 0;
    }
    viewport.style.setProperty(
      '--workflow-scene-height',
      `${scenes.clientHeight}px`,
    );
    let contentHeight = 0;
    for (const scene of artwork) {
      const scale = Math.min(
        1,
        scenes.clientWidth / scene.offsetWidth,
        mobile ? 1 : scenes.clientHeight / scene.offsetHeight,
      );
      scene.style.setProperty('--workflow-scale', String(scale));
      contentHeight = Math.max(contentHeight, scene.offsetHeight * scale);
    }
    viewport.style.setProperty(
      '--workflow-content-height',
      `${contentHeight}px`,
    );
  });
  resize.observe(scenes);
  for (const scene of artwork) resize.observe(scene);
  for (const { element } of entries) resize.observe(element);
  setStep(0);

  return () => {
    clicks.abort();
    controls.dispose();
    disposeTitleAvatars();
    actors.dispose();
    resize.disconnect();
    visibility.disconnect();
  };
}
