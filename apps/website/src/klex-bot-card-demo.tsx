import './klex-bot-card-demo.css';
import './style.css';

import { createRoot } from 'react-dom/client';
import { KlexBotRoster } from './klex-bot-roster';

function BotCardDemo() {
  return (
    <main className="bot-card-demo">
      <header>
        <a href="/" aria-label="Klex home">
          <img src="/klex-logo-light.svg" alt="Klex" width="88" />
        </a>
        <h1>Meet the Klex Bots</h1>
        <p>
          A bot card prototype. Hover or focus to preview; click, Enter, or
          Space to activate.
        </p>
      </header>
      <KlexBotRoster />
      <footer>
        Illustrative identities and workflows. Connector marks belong to their
        respective owners. <a href="/attributions.html">Asset credits</a>.
      </footer>
    </main>
  );
}

const host = document.getElementById('bot-card-demo');
if (host) {
  const root = createRoot(host);
  root.render(<BotCardDemo />);
  import.meta.hot?.dispose(() => root.unmount());
}
