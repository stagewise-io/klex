import { useState } from 'react';

import { usePlay, wait } from '../../workflow/stage';
import type { WorkSceneProps } from './scenes';

type Mail = {
  from: string;
  subject: string;
  snippet: string;
  time: string;
  attachment?: string;
};

const inbox: Mail[] = [
  {
    from: 'Priya Shah',
    subject: 'Re: Interview on Thursday',
    snippet: 'Thursday at 10 works great for me, see you then!',
    time: '9:12',
  },
  {
    from: 'Greenhouse',
    subject: 'Weekly hiring report',
    snippet: '12 new applicants across 3 open roles this week.',
    time: '8:40',
  },
  {
    from: 'Payroll',
    subject: 'September payslips are ready',
    snippet: 'All payslips have been sent to the team.',
    time: 'Sep 28',
  },
  {
    from: 'Office',
    subject: 'Team lunch on Friday',
    snippet: 'We booked the long table at Nolita for 12:30.',
    time: 'Sep 27',
  },
];

const applicants = [
  {
    name: 'Lena Park',
    email: 'lena.park@hey.com',
    role: 'Product Designer',
    body: [
      'Hi Monica,',
      'I’d love to join acme as a Product Designer. For the last four years I’ve designed onboarding flows at a fintech startup.',
      'My portfolio and résumé are attached.',
    ],
    attachment: 'lena-park-resume.pdf',
  },
  {
    name: 'Tom Richter',
    email: 'tom@richter.dev',
    role: 'Frontend Engineer',
    body: [
      'Hello Monica,',
      'I build fast, accessible React apps and I’ve followed acme since your first launch. I’d be happy to talk.',
      'My résumé is attached.',
    ],
    attachment: 'tom-richter-cv.pdf',
  },
  {
    name: 'Aisha Khan',
    email: 'aisha.khan@gmail.com',
    role: 'Customer Success Lead',
    body: [
      'Dear Monica,',
      'I lead a support team of six and love turning unhappy customers into fans. The role sounds like a great fit.',
      'You’ll find my résumé attached.',
    ],
    attachment: 'aisha-khan-resume.pdf',
  },
];

export const monicaScene = {
  count: applicants.length,
  app: () => ({ name: 'Gmail', icon: 'gmail' }),
  Scene: MonicaScene,
};

type Phase = 'inbox' | 'arrived' | 'open' | 'shortlisted';

function MonicaScene({ variant, onDone }: WorkSceneProps) {
  const applicant = applicants[variant];
  const [phase, setPhase] = useState<Phase>('inbox');
  const mail: Mail = {
    from: applicant.name,
    subject: `Application: ${applicant.role}`,
    snippet: applicant.body[1],
    time: '9:41',
    attachment: applicant.attachment,
  };

  usePlay(
    true,
    async (signal) => {
      await wait(700, signal);
      setPhase('arrived');
      await wait(1300, signal);
      setPhase('open');
      await wait(2200, signal);
      setPhase('shortlisted');
      await wait(1800, signal);
    },
    onDone,
  );

  return (
    <div className="new-gmail">
      <header className="new-gmail-top">
        <span className="new-gmail-menu" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <img src="/connectors/gmail.svg" alt="" width="22" height="22" />
        <span className="new-gmail-brand">Gmail</span>
        <span className="new-gmail-search">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          Search mail
        </span>
        <span className="new-gmail-me">M</span>
      </header>
      <div className="new-gmail-body">
        <nav className="new-gmail-rail" aria-hidden="true">
          <span className="new-gmail-compose">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m10.5 2.5 3 3-7.5 7.5H3v-3Z" />
            </svg>
          </span>
          <span className="new-gmail-folder is-active">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 9.5v4h11v-4h-3a2.5 2.5 0 0 1-5 0Zm0 0 1.5-7h8l1.5 7" />
            </svg>
            <b>{phase === 'inbox' ? 2 : 3}</b>
          </span>
          <span className="new-gmail-folder">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5Z" />
            </svg>
          </span>
          <span className="new-gmail-folder">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m2 8 12-5.5L10 14l-2.5-4.5Zm5.5 1.5L14 2.5" />
            </svg>
          </span>
        </nav>
        <main className="new-gmail-panel">
          {phase === 'open' || phase === 'shortlisted' ? (
            <article className="new-gmail-reader new-build-reveal">
              <h4>
                {mail.subject}
                <span className="new-gmail-label">Inbox</span>
                {phase === 'shortlisted' && (
                  <span className="new-gmail-label is-shortlist new-build-reveal">
                    Shortlist
                  </span>
                )}
              </h4>
              <p className="new-gmail-sender">
                <span className="new-gmail-avatar">{applicant.name[0]}</span>
                <span>
                  <strong>{applicant.name}</strong>{' '}
                  <small>&lt;{applicant.email}&gt;</small>
                  <small>to me</small>
                </span>
                <span
                  className="new-gmail-star"
                  data-on={phase === 'shortlisted'}
                  aria-hidden="true"
                >
                  ★
                </span>
              </p>
              {applicant.body.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p className="new-gmail-attachment">
                <span>PDF</span>
                {applicant.attachment}
              </p>
            </article>
          ) : (
            <ul className="new-gmail-list">
              {phase === 'arrived' && <MailRow mail={mail} unread arrived />}
              <MailRow mail={inbox[0]} unread />
              {inbox.slice(1).map((entry) => (
                <MailRow key={entry.subject} mail={entry} />
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}

function MailRow({
  mail,
  unread = false,
  arrived = false,
}: {
  mail: Mail;
  unread?: boolean;
  arrived?: boolean;
}) {
  return (
    <li
      className={`new-gmail-row${unread ? ' is-unread' : ''}${arrived ? ' is-new' : ''}`}
    >
      <span className="new-gmail-row-star" aria-hidden="true">
        ☆
      </span>
      <span className="new-gmail-from">{mail.from}</span>
      <span className="new-gmail-text">
        <strong>{mail.subject}</strong> – {mail.snippet}
      </span>
      {mail.attachment && <span className="new-gmail-chip">PDF</span>}
      <span className="new-gmail-time">{mail.time}</span>
    </li>
  );
}
