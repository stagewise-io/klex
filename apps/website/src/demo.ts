const bot =
  '<img class="avatar bot-avatar" src="/klex-avatar.svg" alt="" width="36" height="36" />';
const identity = '<strong>Klex Bot</strong> <span class="bot-label">BOT</span>';
const mark = (name: string, label: string) =>
  `<img src="/connectors/${name}.svg" alt="" width="22" height="22" />${label}`;

const examples = [
  {
    id: 'slack',
    label: 'Slack',
    content: `<div class="slack-layout">
      <aside class="slack-sidebar" aria-label="Example Slack workspace"><strong>Acme workspace</strong><p>Channels</p><span># general</span><span class="channel-selected"># launch</span><span># engineering</span><p>Direct messages</p><span>Klex Bot <small>BOT</small></span></aside>
      <div class="slack-conversation"><div class="native-toolbar"><strong># launch</strong><span>Launch planning</span></div>
        <div class="date-divider">Today</div>
        <div class="message"><span class="avatar human-avatar" aria-hidden="true">JL</span><div><strong>Jamie Lee</strong> <time>9:41 AM</time><p><span class="mention">@Klex Bot</span> Can you turn yesterday’s launch notes into a checklist for the team?</p></div></div>
        <div class="message">${bot}<div>${identity} <time>9:42 AM</time><p>Here’s a draft for Friday’s launch:</p><ul class="checklist"><li>Engineering — review the release PR</li><li>Marketing — approve the announcement</li><li>Team — confirm the go / no-go at 10 AM</li></ul><p>The open question: who owns the customer email?</p><span class="thread-note">1 reply · Last reply 9:44 AM</span></div></div>
        <div class="message"><span class="avatar human-avatar" aria-hidden="true">JL</span><div><strong>Jamie Lee</strong> <time>9:44 AM</time><p>I’ll take the email. Thanks, Klex!</p></div></div>
        <div class="mock-composer" aria-hidden="true">Message #launch<span>＋ &nbsp; Aa &nbsp; @</span></div>
      </div></div>`,
  },
  {
    id: 'gmail',
    label: mark('gmail', 'Gmail'),
    content: `<div class="google-top">${mark('gmail', 'Gmail')}<span class="mock-search">Search mail</span></div>
      <div class="mail-layout"><aside class="mail-sidebar"><span class="compose-label">Compose</span><strong>Inbox <span>3</span></strong><span>Starred</span><span>Sent</span><span>Drafts</span></aside>
      <div class="email"><div class="native-toolbar">Inbox <span>1 of 3</span></div><h3>Friday launch: the open questions <span class="inbox-label">Inbox</span></h3><div class="message">${bot}<div>${identity}<p class="email-address">klex-bot@example.com · to Jamie</p></div><time>9:48 AM</time></div><div class="email-body"><p>Hi Jamie,</p><p>I pulled the open questions from the launch notes into one place:</p><ul><li>Is the release PR ready for review?</li><li>Who will approve the announcement?</li><li>Should we send the customer email after the go / no-go?</li></ul><p>You’re listed as the owner of the customer email. Let me know what you’d like to change.</p><p>Thanks,<br />Klex Bot<br /><small>Your digital coworker</small></p></div></div></div>`,
  },
  {
    id: 'calendar',
    label: mark('googlecalendar', 'Calendar'),
    content: `<div class="google-top">${mark('googlecalendar', 'Google Calendar')}<span class="mock-search">Friday, October 16 · Example day</span></div>
      <div class="calendar-layout"><div class="day-schedule"><div>09:00</div><div>10:00 <span class="calendar-event">Launch go / no-go<br /><small>10:00 – 10:30 AM</small></span></div><div>11:00</div><div>12:00</div></div><article class="event-detail"><span class="event-square" aria-hidden="true"></span><h3>Launch go / no-go</h3><p>Friday, October 16 · 10:00 – 10:30 AM</p><hr /><strong>Launch checklist review</strong><p>Review the release, announcement, and customer email before we give the green light.</p><hr /><strong>3 guests</strong><p>Jamie Lee <small>· Organizer</small></p><p>Alex Chen</p><div class="attendee">${bot}<span>${identity}<br /><small>Invited · digital coworker</small></span></div></article></div>`,
  },
  {
    id: 'github',
    label: mark('github', 'GitHub'),
    content: `<div class="github-top">${mark('github', 'acme / launch-site')}<span class="repo-visibility">Private</span></div><div class="repo-tabs"><span>Code</span><strong>Pull requests <span>1</span></strong><span>Actions</span></div><div class="pull-request"><h3>Update the launch checklist <span>#42</span></h3><p class="pr-meta"><span class="pr-open">Open</span> <strong>Klex Bot</strong> wants to merge 1 commit into <code>main</code></p><div class="pr-tabs"><strong>Conversation</strong><span>Commits 1</span><span>Files changed 1</span></div><div class="pr-comment"><div class="pr-comment-header">${bot}<span>${identity} commented just now</span></div><div class="pr-comment-body"><p>Added the owners and open questions from the team’s launch discussion.</p><ul><li>Jamie owns the customer email.</li><li>Announcement approval is still open.</li><li>Go / no-go is scheduled for Friday.</li></ul><p>Ready for the team to review.</p></div></div><p class="review-note">Review requested from Jamie Lee</p></div>`,
  },
];

export const demoMarkup = `<div class="connector-demo" aria-label="Klex at work, illustrative examples">
  <div class="demo-heading"><span>One coworker. Familiar places.</span><span class="demo-caption">Illustrative demo</span></div>
  <div class="connector-tabs" role="tablist" aria-label="Choose a connector example">${examples.map(({ id, label }, index) => `<button type="button" role="tab" id="connector-${id}" aria-controls="example-${id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}</div>
  ${examples.map(({ id, content }, index) => `<div class="connector-panel" role="tabpanel" id="example-${id}" aria-labelledby="connector-${id}" tabindex="0" ${index === 0 ? '' : 'hidden'}>${content}</div>`).join('')}
  <p class="demo-disclaimer">Example workflows, not live connections. Available capabilities depend on the MCP servers you connect.</p>
</div>`;

export function initializeDemo() {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '.connector-tabs [role="tab"]',
    ),
  );
  function select(index: number) {
    tabs.forEach((tab, tabIndex) => {
      const selected = tabIndex === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(
        tab.getAttribute('aria-controls') ?? '',
      );
      if (panel) panel.hidden = !selected;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index - 1 + tabs.length) % tabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      select(next);
      tabs[next]?.focus();
    });
  });
}
