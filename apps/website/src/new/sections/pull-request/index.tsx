import './pull-request.css';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { IconCircleCheckOutline18 } from '@stagewise/ui/icons/nucleo/ui-outline-18/IconCircleCheckOutline18.tsx';
import { IconOctagonWarningOutline18 } from '@stagewise/ui/icons/nucleo/ui-outline-18/IconOctagonWarningOutline18.tsx';
import { Button } from '@stagewise/ui/src/components/ui/button.tsx';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@stagewise/ui/src/components/ui/field.tsx';
import { Input } from '@stagewise/ui/src/components/ui/input.tsx';
import {
  createToastManager,
  Toast,
  ToastContent,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from '@stagewise/ui/src/components/ui/toast.tsx';

import { heroLooks } from '../../bot-looks';
import { Klex } from '../../klex';
import { SafariWindow, useCareersZoom } from '../build/safari';
import { SceneProgress } from '../workflow/controls';
import {
  PopBot,
  type PopBotHandle,
  typeText,
  usePlay,
  useStepPlayback,
  wait,
} from '../workflow/stage';

export const pullRequestMarkup = `
      <section class="new-pr-story" aria-labelledby="new-pr-story-title">
        <div id="new-pr-story"></div>
      </section>
`;

const applicant = {
  name: 'Jeff Tester',
  email: 'jeff@acme.design',
  portfolio: 'https://jeff.design',
};

export function PrIcon({ name }: { name: string }) {
  return (
    <svg className="new-pr-icon" viewBox="0 0 16 16" aria-hidden="true">
      <use href={`/github-pr-icons.svg#${name}`} />
    </svg>
  );
}

export function PrComment({
  author,
  bot,
  children,
}: {
  author: string;
  bot: string;
  children: ReactNode;
}) {
  return (
    <div className="new-pr-conversation">
      <div className="new-pr-avatar">
        <Klex
          {...heroLooks[bot]}
          size={38}
          layout="avatar"
          idle={false}
          className="new-pr-klex"
        />
      </div>
      <article className="new-pr-comment">
        <div className="new-pr-comment-header">
          <span>
            <strong>{author}</strong> commented <u>just now</u>
          </span>
          {author === 'jonathan-bot' && (
            <span className="new-pr-author">Author</span>
          )}
          <PrIcon name="kebab-horizontal" />
        </div>
        <div className="new-pr-comment-body">{children}</div>
      </article>
    </div>
  );
}

export function PrEvent({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <p className="new-pr-event">
      <span className="new-pr-event-icon">{icon}</span>
      <span>{children}</span>
    </p>
  );
}

type Review =
  | 'reported'
  | 'fixing'
  | 'fixed'
  | 'retesting'
  | 'approved'
  | 'merged';

function PullRequest({
  review,
  finished,
}: {
  review?: Review;
  finished: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = scroll.current;
    if (!panel || !review) return;
    panel.scrollTo({
      top: panel.scrollHeight,
      behavior:
        finished || matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
    });
  }, [review, finished]);

  const approved = review === 'approved' || review === 'merged';
  const fixed = review === 'fixed' || approved;
  const merged = review === 'merged';
  return (
    <div className="new-pr-scroll" ref={scroll}>
      <div className="new-pr-window">
        <div className="new-pr-header">
          <h3>
            feat(careers): add Product Designer job page{' '}
            <span className="new-pr-number">#42</span>
            <svg className="new-pr-edit new-pr-icon" aria-hidden="true">
              <use href="/github-pr-icons.svg#pencil" />
            </svg>
          </h3>
          <div className="new-pr-meta">
            <span className="new-pr-open" data-merged={merged}>
              <PrIcon name="git-pull-request" />
              {merged ? 'Merged' : 'Open'}
            </span>
            <span className="new-pr-merge">
              <strong>jonathan-bot</strong>{' '}
              {merged ? 'merged' : 'wants to merge'} {fixed ? 2 : 1}{' '}
              {fixed ? 'commits' : 'commit'} into <code>main</code> from{' '}
              <span className="new-pr-head-branch">
                <code>feat/careers-page</code>
                <svg className="new-pr-copy new-pr-icon" aria-hidden="true">
                  <use href="/github-pr-icons.svg#copy" />
                </svg>
              </span>
            </span>
          </div>
        </div>
        <div className="new-pr-tabs" aria-hidden="true">
          <span className="new-pr-tab-active">
            <PrIcon name="comment-discussion" />
            Conversation <b>{review ? (fixed ? 2 : 1) : 0}</b>
          </span>
          <span>
            <PrIcon name="git-commit" />
            Commits <b>{fixed ? 2 : 1}</b>
          </span>
          <span>
            <PrIcon name="checklist" />
            Checks <b>2</b>
          </span>
          <span>
            <PrIcon name="file-diff" />
            Files changed <b>4</b>
          </span>
        </div>
        <div className="new-pr-timeline">
          <PrComment author="jonathan-bot" bot="jonathan">
            <h4>Summary</h4>
            <ul>
              <li>
                Add the Product Designer role and Monica's job description to
                the new careers page.
              </li>
              <li>
                Build an application form with contact details, portfolio link,
                and résumé upload.
              </li>
              <li>Send applications to Monica for review.</li>
            </ul>
            <h4>QA handoff</h4>
            <p>
              Jeff, please submit a test application and check with Monica that
              it arrives with the résumé attached.
            </p>
          </PrComment>
          {review && (
            <div className="new-build-reveal">
              <PrComment author="jeff-bot" bot="jeff">
                <p>
                  Submitting a 2.4 MB PDF résumé fails with “Upload failed”. The
                  upload limit is 1 MB, so an ordinary résumé can’t get through.
                </p>
              </PrComment>
            </div>
          )}
          {fixed && (
            <div className="new-build-reveal">
              <PrEvent icon={<PrIcon name="git-commit" />}>
                <strong>jonathan-bot</strong> pushed 1 commit{' '}
                <code>fix(careers): accept résumés up to 10 MB</code>
              </PrEvent>
              <PrComment author="jonathan-bot" bot="jonathan">
                <p>
                  Fixed in <code>3f9c2a1</code>. Résumés up to 10 MB go through
                  now, and a test covers the limit.
                </p>
              </PrComment>
            </div>
          )}
          {approved && (
            <div className="new-build-reveal">
              <PrEvent
                icon={
                  <svg
                    className="new-pr-icon new-pr-approved"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                  </svg>
                }
              >
                <strong>jeff-bot</strong> approved these changes
              </PrEvent>
            </div>
          )}
          {merged && (
            <div className="new-build-reveal">
              <PrEvent icon={<PrIcon name="git-pull-request" />}>
                <strong>jonathan-bot</strong> merged PR #42 into{' '}
                <code>main</code>
              </PrEvent>
              <PrEvent icon={<PrIcon name="checklist" />}>
                Careers page deployed to <strong>acme.design/careers</strong>
              </PrEvent>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ApplicationToasts({ type }: { type: 'error' | 'success' }) {
  const { toasts } = useToastManager();
  return (
    <ToastViewport className="new-test-toasts">
      {toasts
        .filter((toast) => toast.type === type)
        .map((toast) => (
          <Toast key={toast.id} toast={toast}>
            <ToastContent>
              {type === 'error' ? (
                <IconOctagonWarningOutline18
                  className="size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
              ) : (
                <IconCircleCheckOutline18
                  className="size-4 shrink-0"
                  aria-hidden="true"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <ToastTitle />
                <ToastDescription />
              </div>
            </ToastContent>
          </Toast>
        ))}
    </ToastViewport>
  );
}

function ApplicationPage({
  values,
  resume,
  submitting,
}: {
  values: typeof applicant;
  resume: boolean;
  submitting: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  useCareersZoom(viewport);
  return (
    <div className="new-careers-scroll" ref={viewport} inert>
      <div className="new-careers-page">
        <nav
          className="new-careers-nav"
          aria-label="Careers preview navigation"
        >
          <span className="new-careers-brand">
            acme<span>.</span>
          </span>
          <span>Our team</span>
          <span>Open roles</span>
        </nav>
        <form
          className="new-careers-form"
          onSubmit={(event) => event.preventDefault()}
        >
          <h4>Apply for Product Designer</h4>
          <p>Tell us a little about yourself.</p>
          <FieldGroup>
            <div className="new-careers-form-row">
              <Field>
                <FieldLabel htmlFor="test-name">Full name</FieldLabel>
                <Input
                  id="test-name"
                  value={values.name}
                  placeholder="Your name"
                  readOnly
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="test-email">Email address</FieldLabel>
                <Input
                  id="test-email"
                  value={values.email}
                  placeholder="you@example.com"
                  readOnly
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="test-portfolio">Portfolio URL</FieldLabel>
              <Input
                id="test-portfolio"
                value={values.portfolio}
                placeholder="https://yourportfolio.com"
                readOnly
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="test-resume">Résumé</FieldLabel>
              <Input
                id="test-resume"
                value={resume ? 'jeff-resume.pdf · 2.4 MB' : ''}
                placeholder="Choose a PDF"
                readOnly
              />
            </Field>
            <Button
              className="new-careers-submit"
              type="submit"
              data-pressed={submitting}
            >
              Send application <span aria-hidden="true">↗</span>
            </Button>
          </FieldGroup>
        </form>
      </div>
    </div>
  );
}

function TestScene({
  playing,
  finished,
  skipArrival,
  onComplete,
}: {
  playing: boolean;
  finished: boolean;
  skipArrival: boolean;
  onComplete: () => void;
}) {
  const jeff = useRef<PopBotHandle>(null);
  const jonathan = useRef<PopBotHandle>(null);
  const [toasts] = useState(() => createToastManager());
  const [values, setValues] = useState(
    finished ? applicant : { name: '', email: '', portfolio: '' },
  );
  const [resume, setResume] = useState(finished);
  const [submitting, setSubmitting] = useState(false);
  const [review, setReview] = useState<Review | undefined>(
    finished ? 'merged' : undefined,
  );
  const [progress, setProgress] = useState(finished ? 1 : 0);

  usePlay(
    playing,
    async (signal) => {
      setProgress(0.03);
      await Promise.all([
        jeff.current?.show(signal, skipArrival),
        jonathan.current?.show(signal, skipArrival),
      ]);
      await wait(900, signal);
      jeff.current?.setActivity('working');
      jeff.current?.say('Testing…');
      jonathan.current?.emote('innocent');
      for (const field of ['name', 'email', 'portfolio'] as const) {
        await typeText(
          applicant[field],
          (value) => {
            setValues((current) => ({ ...current, [field]: value }));
            setProgress(
              0.06 +
                (['name', 'email', 'portfolio'].indexOf(field) +
                  value.length / applicant[field].length) *
                  0.08,
            );
          },
          signal,
        );
        await wait(200, signal);
      }
      setProgress(0.3);
      setResume(true);
      await wait(700, signal);
      setProgress(0.38);
      setSubmitting(true);
      await wait(500, signal);
      toasts.add({
        title: 'Couldn’t send application',
        description: 'Upload failed. Résumés must be smaller than 1 MB.',
        type: 'error',
        timeout: 0,
      });
      setSubmitting(false);
      jeff.current?.setActivity('idle');
      jeff.current?.say(null);
      jeff.current?.emote('huh');
      await wait(2000, signal);

      setProgress(0.5);
      jeff.current?.setActivity('working');
      jeff.current?.say('Writing…');
      await wait(1200, signal);
      setReview('reported');
      jeff.current?.setActivity('idle');
      jeff.current?.say(null);
      await wait(1200, signal);
      setProgress(0.7);
      setReview('fixing');
      jonathan.current?.setActivity('working');
      jonathan.current?.say('Fixing…');
      await wait(2200, signal);
      jonathan.current?.setActivity('idle');
      jonathan.current?.say(null);
      setProgress(0.82);
      setReview('fixed');
      jonathan.current?.emote('happy-nod');
      await wait(1800, signal);
      setProgress(0.86);
      setReview('retesting');
      jeff.current?.setActivity('working');
      jeff.current?.say('Testing…');
      await wait(900, signal);
      setSubmitting(true);
      await wait(700, signal);
      setSubmitting(false);
      toasts.add({
        title: 'Application sent',
        description:
          'Monica received the application with the 2.4 MB résumé attached.',
        type: 'success',
        timeout: 0,
      });
      await wait(1800, signal);
      jeff.current?.setActivity('idle');
      jeff.current?.say(null);
      setProgress(0.94);
      setReview('approved');
      jeff.current?.emote('happy-nod');
      await wait(1200, signal);
      setReview('merged');
      setProgress(0.98);
      await wait(1600, signal);
      setProgress(1);
    },
    onComplete,
  );

  return (
    <>
      <div className="new-test-frame">
        <ToastProvider toastManager={toasts}>
          {review && review !== 'retesting' ? (
            <SafariWindow
              app="GitHub"
              address="github.com / acme / careers / pull / 42"
              label="The pull request, with Jeff's bug report and Jonathan's fix"
            >
              <PullRequest review={review} finished={finished} />
            </SafariWindow>
          ) : (
            <SafariWindow
              enter={finished ? undefined : playing}
              address="pr-42.preview.acme.design / careers"
              label="Jeff submits a test application on the preview deployment"
            >
              <ApplicationPage
                values={values}
                resume={resume}
                submitting={submitting}
              />
              <ApplicationToasts
                type={review === 'retesting' ? 'success' : 'error'}
              />
            </SafariWindow>
          )}
        </ToastProvider>
        <PopBot
          visible={finished}
          ref={jeff}
          bot="jeff"
          className="is-right"
          speech="left"
        />
        <PopBot
          visible={finished}
          ref={jonathan}
          bot="jonathan"
          className="is-left"
          facing="right"
        />
      </div>
      <SceneProgress progress={progress} />
    </>
  );
}

function TestStory() {
  const { host, run, playing, finished, skipArrival, onComplete } =
    useStepPlayback();
  return (
    <div ref={host}>
      <TestScene
        key={run}
        playing={playing}
        finished={finished}
        skipArrival={skipArrival}
        onComplete={onComplete}
      />
    </div>
  );
}

export function mountPullRequest() {
  const host = document.getElementById('new-pr-story');
  if (!host) throw new Error('The pull request story container is missing.');
  const root = createRoot(host);
  root.render(<TestStory />);
  return () => root.unmount();
}
