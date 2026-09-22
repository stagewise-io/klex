const avatar = '<img src="/klex-avatar.svg" alt="" width="64" height="64" />';

const capabilities = [
  [
    'Your data. Your choice.',
    'Klex is open-source. Self-host your bots and keep their data on infrastructure you control. Choose the model providers that work for your company.',
  ],
  [
    'Give access with intention.',
    'Bots act through connected tools. Choose the connectors, scope their permissions, and monitor the work they perform.',
  ],
  [
    'Machines change. Your bot stays.',
    'A bot’s identity and memory live separately from its work environments. Machine updates affect the connected environment, while the bot keeps its context.',
  ],
  [
    'A teammate in the thread.',
    'Each bot has its own identity. Bring it into a Slack thread so the whole team can ask questions, share context, and follow the work.',
  ],
  [
    'Context that carries forward.',
    'Memory preserves relationships, facts, and processes across conversations. Your team can build on what the bot already knows.',
  ],
];

const stories = [
  {
    name: 'Kristine',
    role: 'Product Manager',
    title: 'From customer signal to a clear next step.',
    description:
      'Kristine takes reports from Slack and PostHog, checks GitHub for context, and creates Linear issues for the team.',
    app: 'slack',
    label: '# product-feedback',
    message:
      'The checkout reports point to the same issue. I checked GitHub and created a Linear issue with the reproduction steps.',
    result: 'Ready for engineering',
    detail: 'Slack + PostHog → GitHub → Linear',
  },
  {
    name: 'Jonathan',
    role: 'Engineer',
    title: 'Give the issue to someone who can build it.',
    description:
      'Jonathan has his own computer sandbox. He uses Codex to work through Linear issues and prepare pull requests for review.',
    app: 'github',
    label: 'checkout / pull requests',
    message: 'Fix checkout retry handling',
    result: 'Pull request ready for review',
    detail: 'Linear → Computer sandbox + Codex → GitHub',
  },
  {
    name: 'Nat',
    role: 'Quality Engineer',
    title: 'Your standards, in every review.',
    description:
      'Nat reviews pull requests against your company handbook, bringing the team’s shared expectations into the review.',
    app: 'github',
    label: 'Pull request review',
    message:
      'Checked against the company handbook: the retry path needs a regression test before this is ready to merge.',
    result: 'Changes requested',
    detail: 'GitHub → Company handbook → Review',
  },
];

export const sectionsMarkup = `
  <section class="positioning content-section" aria-labelledby="positioning-title">
    <h2 id="positioning-title">Personal AI-Assistants don't work for your business.<br /><span>Klex Bots are Digital Coworkers that do.</span></h2>
    <p>Once a Klex Bot is set up, it can be used by your whole company. It’s like asking David where he saved the notes of yesterday's conference. Or asking Sara to organize the latest Linear issues.</p>
  </section>
  <section class="capabilities content-section" aria-labelledby="capabilities-title">
    <div class="section-intro"><h2 id="capabilities-title">Built to belong<br />in your company.</h2><p>Its own identity. Shared context.<br />Tools you control.</p>${avatar}</div>
    <div class="capability-list">${capabilities.map(([title, description]) => `<article><h3>${title}</h3><p>${description}</p></article>`).join('')}</div>
  </section>
  <section class="company-stories content-section" aria-labelledby="companies-title">
    <h2 id="companies-title">Listen to companies that are already bot-native:</h2>
    <div class="company-tabs" role="tablist" aria-label="Company stories">${['Marcel AI-Startup', 'Tobi Software-Agency', 'Jeff Trucking company'].map((label, index) => `<button type="button" role="tab" id="company-tab-${index}" aria-controls="company-panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}</div>
    ${['Marcel', 'Tobi', 'Jeff'].map((name, index) => `<div class="company-panel" role="tabpanel" id="company-panel-${index}" aria-labelledby="company-tab-${index}" tabindex="0" ${index === 0 ? '' : 'hidden'}><p>${name}’s story</p><p class="story-pending">Interview coming soon.</p><p>We’ll share the conversation here when it’s available.</p></div>`).join('')}
  </section>
  <section class="team-stories content-section" aria-labelledby="team-title">
    <h2 id="team-title">Meet your digital coworkers.</h2>
    <p class="section-description">A product team, working together. Illustrative workflows using connected tools.</p>
    ${stories.map((story) => `<article class="bot-story"><div class="bot-story-copy"><div class="bot-identity">${avatar}<div><h3>${story.name}</h3><span>${story.role}</span></div></div><h4>${story.title}</h4><p>${story.description}</p></div><div class="story-example"><div class="story-app-bar"><img src="/connectors/${story.app}.svg" alt="${story.app === 'slack' ? 'Slack' : 'GitHub'}" width="22" height="22" /><strong>${story.label}</strong><span>Example</span></div><div class="story-message"><img class="avatar bot-avatar" src="/klex-avatar.svg" alt="" width="36" height="36" /><div><strong>${story.name}</strong> <span class="bot-label">BOT</span><p>${story.message}</p><span class="story-result">${story.result}</span></div></div><p class="story-flow">${story.detail}</p></div></article>`).join('')}
  </section>
  <section class="guides content-section" aria-labelledby="guides-title">
    <h2 id="guides-title">Guides on How to Operate a Bot-Native Company</h2>
    <p class="section-description">Start with the habits that make a team work well together.</p>
    <details><summary>Write a handbook your bots can use</summary><p>Document how your team makes decisions, what good work looks like, and when to ask a person for help. Keep the handbook in a shared location accessible through a connector, and ask your bots to consult it before reviewing work.</p></details>
    <details><summary>Give every coworker an identity</summary><p>Give each bot a clear name and role. Set up its own accounts in connected tools, with only the permissions its work requires. Make its role visible so teammates know which bot to involve.</p></details>
    <details><summary>Keep work on shared boards</summary><p>Track assignments, owners, and acceptance criteria in the same board your team uses. Ask bots to link their updates to the issue and put review requests where a teammate can act on them.</p></details>
  </section>
`;

export function initializeCompanyTabs() {
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.company-tabs [role="tab"]'),
  );
  const select = (index: number) => {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      const panel = document.getElementById(`company-panel-${i}`);
      if (panel) panel.hidden = i !== index;
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index + tabs.length - 1) % tabs.length
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
