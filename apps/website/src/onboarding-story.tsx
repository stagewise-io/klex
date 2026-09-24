import './klex-bot-panel.css';

import { createRoot } from 'react-dom/client';

import { ConnectorPanels } from './connector-shells';
import { KlexBotRoster } from './klex-bot-roster';

function OnboardingStory() {
  return (
    <section
      className="coworker-demo"
      aria-label="Your digital coworkers in familiar tools"
    >
      <KlexBotRoster>
        {(selection) => <ConnectorPanels selection={selection} />}
      </KlexBotRoster>
      <p className="demo-disclaimer">
        Illustrative coworkers and workflows, not live connections. Available
        capabilities depend on the MCP servers you connect.
      </p>
    </section>
  );
}
export function mountOnboardingStory() {
  const host = document.getElementById('onboarding-story');
  if (!host) return () => {};
  const root = createRoot(host);
  root.render(<OnboardingStory />);
  return () => root.unmount();
}
