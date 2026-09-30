import { useRef, useState } from 'react';

import { PrComment, PrEvent, PrIcon } from '../../pull-request';
import { typeText, usePlay, wait } from '../../workflow/stage';
import type { WorkSceneProps } from './scenes';

const tests = [
  {
    plan: 'team',
    email: 'jeff@acme.test',
    pr: { number: 59, title: 'feat(pricing): add Team plan checkout' },
    comment:
      'Tested the checkout on the preview. Plan picker, email check and the welcome screen all work.',
  },
  {
    plan: 'starter',
    email: 'qa+starter@acme.test',
    pr: { number: 62, title: 'feat(signup): free Starter plan' },
    comment:
      'Signed up on Starter without a card. No payment step, and the welcome screen shows up right away.',
  },
] as const;

type Target = 'starter' | 'team' | 'email' | 'submit';
type Phase = 'test' | 'done' | 'review' | 'approved';

export const jeffScene = {
  count: tests.length,
  app: () => ({ name: 'Browser', icon: 'chrome' }),
  Scene: JeffScene,
};

function JeffScene({ variant, setApp, onDone }: WorkSceneProps) {
  const test = tests[variant];
  const page = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ x: 360, y: 250, down: false });
  const [plan, setPlan] = useState<string>();
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>('test');

  const moveTo = async (target: Target, signal: AbortSignal) => {
    const element = page.current?.querySelector<HTMLElement>(
      `[data-target="${target}"]`,
    );
    if (!element) return;
    setCursor({
      x: element.offsetLeft + element.offsetWidth * 0.6,
      y: element.offsetTop + element.offsetHeight * 0.6,
      down: false,
    });
    await wait(650, signal);
    setCursor((current) => ({ ...current, down: true }));
    await wait(150, signal);
    setCursor((current) => ({ ...current, down: false }));
  };

  usePlay(
    true,
    async (signal) => {
      await wait(500, signal);
      await moveTo(test.plan, signal);
      setPlan(test.plan);
      await wait(250, signal);
      await moveTo('email', signal);
      await typeText(test.email, setEmail, signal, 1);
      await wait(250, signal);
      await moveTo('submit', signal);
      setPhase('done');
      await wait(1300, signal);
      setApp({ name: 'GitHub', icon: 'github' });
      setPhase('review');
      await wait(1500, signal);
      setPhase('approved');
      await wait(1600, signal);
    },
    onDone,
  );

  if (phase === 'review' || phase === 'approved')
    return (
      <div className="new-work-pr new-pr-window">
        <div className="new-pr-header">
          <h3>
            {test.pr.title}{' '}
            <span className="new-pr-number">#{test.pr.number}</span>
          </h3>
          <div className="new-pr-meta">
            <span className="new-pr-open">
              <PrIcon name="git-pull-request" />
              Open
            </span>
          </div>
        </div>
        <div className="new-pr-timeline">
          <div className="new-build-reveal">
            <PrComment author="jeff-bot" bot="jeff">
              <p>{test.comment}</p>
            </PrComment>
          </div>
          {phase === 'approved' && (
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
        </div>
      </div>
    );

  return (
    <div className="new-demo" ref={page}>
      <nav className="new-demo-nav">
        <span className="new-careers-brand">
          acme<span>.</span>
        </span>
        <span>Product</span>
        <span>Pricing</span>
      </nav>
      {phase === 'done' ? (
        <div className="new-demo-success new-build-reveal">
          <span aria-hidden="true">✓</span>
          <h4>Welcome to acme {plan === 'team' ? 'Team' : 'Starter'}!</h4>
          <p>We sent a confirmation to {test.email}.</p>
        </div>
      ) : (
        <>
          <h4 className="new-demo-title">Pick your plan</h4>
          <div className="new-demo-plans">
            <p data-target="starter" data-selected={plan === 'starter'}>
              <strong>Starter</strong>
              <span>€0 / month</span>
            </p>
            <p data-target="team" data-selected={plan === 'team'}>
              <strong>Team</strong>
              <span>€12 / seat</span>
            </p>
          </div>
          <p className="new-demo-input" data-target="email">
            {email || <span>you@company.com</span>}
          </p>
          <p className="new-demo-submit" data-target="submit">
            Start free trial
          </p>
        </>
      )}
      <svg
        className="new-demo-cursor"
        data-down={cursor.down}
        style={{ translate: `${cursor.x}px ${cursor.y}px` }}
        viewBox="0 0 16 20"
        aria-hidden="true"
      >
        <path d="M1 1v15.5l4.2-4 2.8 6.5 2.6-1.1-2.8-6.4H14Z" />
      </svg>
    </div>
  );
}
