import './base.css';
import './navigation.css';

import { mountLogoMenus } from './logo-menu';
import { mountNearViewport } from './mount-near-viewport';
import { mountNavigation } from './navigation';
import { mountHero } from './sections/hero';
import { createTelemetry } from './telemetry';

const telemetry = createTelemetry();
void telemetry.initialize();

const app = document.getElementById('app');
if (!app) throw new Error('The website root is missing.');
if (!app.hasChildNodes())
  app.innerHTML = (await import('./page-markup')).pageMarkup;

// Prerendered sections need their styles before the islands load.
import.meta.glob('./sections/**/*.css', { eager: true });

const events = new AbortController();
const theme = matchMedia('(prefers-color-scheme: dark)');
theme.addEventListener(
  'change',
  ({ matches }) => document.documentElement.classList.toggle('dark', matches),
  { signal: events.signal },
);

const disposers = [
  mountLogoMenus(app),
  mountNavigation(),
  mountHero(),
  mountNearViewport([
    [
      '.new-workflow',
      async () => {
        const [slack, build, pr, report, workflow] = await Promise.all([
          import('./sections/slack'),
          import('./sections/build'),
          import('./sections/pull-request'),
          import('./sections/report'),
          import('./sections/workflow'),
        ]);
        // Scene listeners must exist before the coordinator sends STEP_ENTER.
        return () => {
          const cleanup = [
            slack.mountSlack(),
            build.mountBuild(),
            pr.mountPullRequest(),
            report.mountReport(),
            workflow.mountWorkflow(),
          ];
          return () => {
            for (const dispose of cleanup.reverse()) dispose();
          };
        };
      },
    ],
    [
      '.new-coworkers',
      () =>
        import('./sections/coworkers').then((module) => module.mountCoworkers),
    ],
    [
      '.new-trust',
      // The office drawing is prerendered, so only load the interactive parts.
      () =>
        import('./sections/trust/principles').then(
          (module) => module.mountTrust,
        ),
    ],
    [
      '.new-guides-faq',
      () =>
        import('./sections/guides-faq').then((module) => module.mountGuidesFaq),
    ],
    [
      '.new-features',
      () =>
        import('./sections/features').then((module) => module.mountFeatures),
    ],
  ]),
];

import.meta.hot?.dispose(() => {
  events.abort();
  for (const dispose of disposers) dispose();
});
