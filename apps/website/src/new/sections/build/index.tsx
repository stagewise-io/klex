import './build.css';

import { Code } from '@sugar-high/react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Badge } from '@stagewise/ui/src/components/ui/badge.tsx';
import { Button } from '@stagewise/ui/src/components/ui/button.tsx';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@stagewise/ui/src/components/ui/card.tsx';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@stagewise/ui/src/components/ui/field.tsx';
import { Input } from '@stagewise/ui/src/components/ui/input.tsx';

import { careersIssue, LinearIssueDialog, typeIssueText } from '../linear';
import { SceneProgress } from '../workflow/controls';
import {
  PopBot,
  type PopBotHandle,
  typeText,
  usePlay,
  useStepPlayback,
  WalkingBot,
  type WalkingBotHandle,
  wait,
} from '../workflow/stage';
import { SafariWindow, useCareersZoom, WindowLabel } from './safari';

const codeSteps = [
  `import {
  Badge, Button, Card, CardContent, CardHeader,
  CardTitle, Field, FieldGroup, FieldLabel, Input,
} from '@stagewise/ui';

export function CareersPage() {
  return (
    <main className="careers">
      <nav>acme. <a href="#apply">Apply now ↗</a></nav>
`,
  `      <header>
        <p>Careers at acme</p>
        <h1>Design what’s next.</h1>
        <p>Join a small team building better ways to work.</p>
      </header>
`,
  `      <Card>
        <CardHeader>
          <Badge variant="secondary">Open position</Badge>
          <CardTitle>Product Designer</CardTitle>
        </CardHeader>
        <CardContent>Full-time · Remote / Berlin</CardContent>
      </Card>
`,
  `      <form
        id="apply"
        action="/api/applications"
        method="post"
        encType="multipart/form-data"
      >
        <h2>Apply for this role</h2>
        <p>Tell us a little about yourself.</p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Full name</FieldLabel>
            <Input id="name" name="name" placeholder="Your name" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email address</FieldLabel>
            <Input id="email" name="email" type="email" required />
          </Field>
`,
  `          <Field>
            <FieldLabel htmlFor="portfolio">Portfolio URL</FieldLabel>
            <Input id="portfolio" name="portfolio" type="url" />
          </Field>
          <Field>
            <FieldLabel htmlFor="resume">Résumé</FieldLabel>
            <Input
              id="resume"
              name="resume"
              type="file"
              accept=".pdf,.doc,.docx"
              required
            />
          </Field>
`,
  `          <Button type="submit">Send application ↗</Button>
        </FieldGroup>
      </form>
    </main>
  );
}
`,
];

const fullCode = codeSteps.join('');
const stepEnds = codeSteps.map(
  (_, index) => codeSteps.slice(0, index + 1).join('').length,
);

export const codeTheme = {
  background: '#151922',
  foreground: '#e4e9f1',
  title: '#c9d3e2',
  control: '#667184',
  lineNumber: '#697589',
  keyword: '#b8a2f2',
  string: '#a8d5a2',
  entity: '#8fc8ed',
  sign: '#b9c6d9',
  property: '#e8bf96',
};

function CareersPreview({ step }: { step: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  useCareersZoom(viewport);

  useEffect(() => {
    if (step >= 4) {
      viewport.current?.scrollTo({
        top: viewport.current.scrollHeight,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
    }
  }, [step]);

  return (
    <div className="new-careers-scroll" ref={viewport} inert>
      <div className="new-careers-page">
        {step >= 1 && (
          <nav
            className="new-careers-nav new-build-reveal"
            aria-label="Careers preview navigation"
          >
            <span className="new-careers-brand">
              acme<span>.</span>
            </span>
            <span>Our team</span>
            <span>Open roles</span>
            <span className="new-careers-nav-cta">Apply now ↗</span>
          </nav>
        )}
        {step >= 2 && (
          <header className="new-careers-hero new-build-reveal">
            <p>CAREERS AT ACME</p>
            <h3>Design what’s next.</h3>
            <span>Join a small team building better ways to work.</span>
          </header>
        )}
        {step >= 3 && (
          <Card className="new-careers-role new-build-reveal">
            <CardHeader>
              <Badge variant="secondary">Open position</Badge>
              <CardTitle>Product Designer</CardTitle>
            </CardHeader>
            <CardContent>
              Full-time <i /> Remote / Berlin
            </CardContent>
            <span className="new-careers-role-arrow" aria-hidden="true">
              ↗
            </span>
          </Card>
        )}
        {step >= 4 && (
          <form
            className="new-careers-form new-build-reveal"
            id="apply"
            action="/api/applications"
            method="post"
            encType="multipart/form-data"
            onSubmit={(event) => event.preventDefault()}
          >
            <h4>Apply for this role</h4>
            <p>Tell us a little about yourself.</p>
            <FieldGroup>
              <div className="new-careers-form-row">
                <Field>
                  <FieldLabel htmlFor="preview-name">Full name</FieldLabel>
                  <Input
                    id="preview-name"
                    name="name"
                    placeholder="Your name"
                    readOnly
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="preview-email">Email address</FieldLabel>
                  <Input
                    id="preview-email"
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    readOnly
                  />
                </Field>
              </div>
              {step >= 5 && (
                <div className="new-careers-form-extra new-build-reveal">
                  <Field>
                    <FieldLabel htmlFor="preview-portfolio">
                      Portfolio URL
                    </FieldLabel>
                    <Input
                      id="preview-portfolio"
                      name="portfolio"
                      type="url"
                      placeholder="https://yourportfolio.com"
                      readOnly
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="preview-resume">Résumé</FieldLabel>
                    <Input
                      id="preview-resume"
                      name="resume"
                      type="file"
                      accept=".pdf,.doc,.docx"
                      className="new-careers-upload"
                      disabled
                    />
                  </Field>
                </div>
              )}
              {step >= 6 && (
                <Button
                  className="new-careers-submit new-build-reveal"
                  type="submit"
                  disabled
                >
                  Send application <span aria-hidden="true">↗</span>
                </Button>
              )}
            </FieldGroup>
          </form>
        )}
      </div>
    </div>
  );
}

const pullRequestTitle = 'feat(careers): add Product Designer job page';

export function GitHubPullRequest({
  title,
  created,
  repo = 'careers',
  branch = 'feat/careers-page',
  number = 42,
  body = 'Adds the Product Designer role and an application form. Résumés are sent to Monica. Closes PRO-42.',
}: {
  title: string;
  created: boolean;
  repo?: string;
  branch?: string;
  number?: number;
  body?: string;
}) {
  return (
    <div className="new-gh-page">
      <p className="new-gh-repo">
        <img src="/connectors/github.svg" alt="" width="16" height="16" />
        acme / <strong>{repo}</strong>
      </p>
      {created ? (
        <div className="new-gh-created new-build-reveal">
          <h4>
            {title} <span>#{number}</span>
          </h4>
          <p>
            <span className="new-gh-state">Open</span>
            <strong>jonathan-bot</strong> wants to merge 1 commit into{' '}
            <code>main</code> from <code>{branch}</code>
          </p>
          <p className="new-gh-checks">
            <span aria-hidden="true">✓</span> All checks have passed · Preview
            deployed
          </p>
        </div>
      ) : (
        <div className="new-gh-compare new-build-reveal">
          <h4>Open a pull request</h4>
          <p className="new-gh-branches">
            <code>base: main</code> ← <code>compare: {branch}</code>
            <span>✓ Able to merge</span>
          </p>
          <p className="new-gh-input">
            {title || <span className="new-gh-placeholder">Title</span>}
          </p>
          <p className="new-gh-input new-gh-body">{body}</p>
          <span className="new-gh-button" data-ready={!!title}>
            Create pull request
          </span>
        </div>
      )}
    </div>
  );
}

type BuildPhase = 'ticket' | 'code' | 'compare' | 'created';

function BuildScene({
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
  const workspace = useRef<HTMLDivElement>(null);
  const codeScroll = useRef<HTMLDivElement>(null);
  const kristine = useRef<WalkingBotHandle>(null);
  const jonathan = useRef<WalkingBotHandle>(null);
  const jeff = useRef<PopBotHandle>(null);
  const [open, setOpen] = useState(finished);
  const [length, setLength] = useState(finished ? fullCode.length : 0);
  const [phase, setPhase] = useState<BuildPhase>(
    finished ? 'created' : 'ticket',
  );
  const [issueTitle, setIssueTitle] = useState('');
  const [issueDescription, setIssueDescription] = useState('');
  const [assignee, setAssignee] = useState<string>();
  const [createdAs, setCreatedAs] = useState<string>();
  const [title, setTitle] = useState(finished ? pullRequestTitle : '');
  const [progress, setProgress] = useState(finished ? 1 : 0);
  const step = stepEnds.filter((end) => length >= end).length;

  usePlay(
    playing,
    async (signal) => {
      setProgress(0.03);
      await kristine.current?.walkTo({ edge: 'center' }, signal, skipArrival);
      kristine.current?.setActivity('working');
      kristine.current?.say('Planning…');
      await wait(400, signal);
      await typeIssueText(
        careersIssue.title,
        (value) => {
          setIssueTitle(value);
          setProgress(0.03 + (0.07 * value.length) / careersIssue.title.length);
        },
        signal,
        650,
      );
      await wait(300, signal);
      await typeIssueText(
        careersIssue.description,
        (value) => {
          setIssueDescription(value);
          setProgress(
            0.1 + (0.12 * value.length) / careersIssue.description.length,
          );
        },
        signal,
        1400,
      );
      await wait(400, signal);
      setAssignee('Jonathan');
      await wait(700, signal);
      setCreatedAs('PRO-42');
      setProgress(0.25);
      kristine.current?.setActivity('idle');
      kristine.current?.say(null);
      kristine.current?.emote('happy-nod');
      await kristine.current?.walkTo({ edge: 'center', offset: -0.6 }, signal);
      await jonathan.current?.walkTo(
        { edge: 'center', offset: 0.3 },
        signal,
        skipArrival,
      );
      await wait(450, signal);
      await kristine.current?.walkTo('offstage-top', signal);

      setPhase('code');
      setProgress(0.35);
      setOpen(true);
      await jonathan.current?.walkTo({ edge: 'center' }, signal);
      jonathan.current?.setActivity('working');
      jonathan.current?.say('Coding…');
      for (let next = 14; next < fullCode.length; next += 14) {
        setLength(next);
        setProgress(0.35 + (0.45 * next) / fullCode.length);
        await wait(32, signal);
      }
      setLength(fullCode.length);
      jonathan.current?.say(null);
      await wait(1800, signal);

      setPhase('compare');

      setProgress(0.82);
      await wait(900, signal);
      await typeText(
        pullRequestTitle,
        (value) => {
          setTitle(value);
          setProgress(0.82 + (0.08 * value.length) / pullRequestTitle.length);
        },
        signal,
      );
      await wait(600, signal);
      setPhase('created');
      setProgress(0.94);
      jonathan.current?.setActivity('idle');
      jonathan.current?.say(null);
      jonathan.current?.emote('happy-nod');
      await wait(700, signal);
      await jonathan.current?.walkTo({ edge: 'center', offset: -0.6 }, signal);
      await jeff.current?.show(signal);
      await wait(450, signal);
      jeff.current?.emote('happy-nod');
      await wait(900, signal);
      jonathan.current?.say(null);
      setProgress(1);
    },
    onComplete,
  );

  useEffect(() => {
    if (finished || length === 0) return;
    const panel = codeScroll.current;
    if (!panel) return;
    if (length < fullCode.length) {
      panel.scrollTop = panel.scrollHeight;
      return;
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setTimeout(() => {
      panel.scrollTo({ top: 0, behavior: 'smooth' });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [finished, length]);

  const onGitHub = phase === 'compare' || phase === 'created';
  return (
    <>
      <div className="new-build-stage" ref={workspace}>
        {phase === 'ticket' ? (
          <div className="new-build-ticket">
            <WindowLabel title="Linear" icon="linear" />
            <LinearIssueDialog
              title={issueTitle}
              description={issueDescription}
              assignee={assignee}
              createdAs={createdAs}
            />
          </div>
        ) : (
          <div
            className="new-build-workspace"
            data-phase={onGitHub ? 'github' : 'code'}
            data-open={open}
          >
            <div className="new-build-editor" aria-hidden={onGitHub}>
              <WindowLabel title="Code" icon="vscode" />
              <div className="new-build-code-scroll" ref={codeScroll}>
                <Code
                  lang="typescript"
                  title="careers-page.tsx"
                  controls
                  lineNumbers
                  wrapLongLines={false}
                  theme={codeTheme}
                >
                  {fullCode.slice(0, length) || ' '}
                </Code>
              </div>
            </div>
            {onGitHub ? (
              <SafariWindow
                app="GitHub"
                address={
                  phase === 'created'
                    ? 'github.com / acme / careers / pull / 42'
                    : 'github.com / acme / careers / compare'
                }
                label="Jonathan opens a pull request on GitHub"
              >
                <GitHubPullRequest
                  title={title}
                  created={phase === 'created'}
                />
              </SafariWindow>
            ) : (
              <SafariWindow
                address="localhost:5173 / careers"
                label="Animated preview of a Product Designer careers page being built"
              >
                <CareersPreview step={step} />
              </SafariWindow>
            )}
          </div>
        )}
        {!finished && (
          <WalkingBot
            ref={kristine}
            bot="kristine"
            anchor={workspace}
            start="offstage-top"
          />
        )}
        <WalkingBot
          ref={jonathan}
          settled={finished}
          bot="jonathan"
          anchor={workspace}
          speech="left"
          start={finished ? { edge: 'center', offset: -0.6 } : 'offstage-top'}
        />
        <PopBot
          ref={jeff}
          bot="jeff"
          visible={finished}
          className="new-build-jeff"
        />
      </div>
      <SceneProgress progress={progress} />
    </>
  );
}

function BuildStory() {
  const { host, run, playing, finished, skipArrival, onComplete } =
    useStepPlayback();
  return (
    <div ref={host}>
      <BuildScene
        key={run}
        playing={playing}
        finished={finished}
        skipArrival={skipArrival}
        onComplete={onComplete}
      />
    </div>
  );
}

export const buildMarkup = `
      <section class="new-build-story" aria-labelledby="new-build-story-title">
        <div id="new-build-story"></div>
      </section>
`;

export function mountBuild() {
  const host = document.getElementById('new-build-story');
  if (!host) throw new Error('The build story container is missing.');
  const root = createRoot(host);
  root.render(<BuildStory />);
  return () => root.unmount();
}
