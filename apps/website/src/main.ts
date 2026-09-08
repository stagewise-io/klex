import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Klex application root was not found.');
}

const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');

const installers = {
  unix: 'curl -fsSL https://klex.bot/install.sh | sh',
  windows: 'irm https://klex.bot/install.ps1 | iex',
} as const;

type InstallerPlatform = keyof typeof installers;

const detectedPlatform: InstallerPlatform = /Windows|Win32|Win64/i.test(
  `${navigator.platform} ${navigator.userAgent}`,
)
  ? 'windows'
  : 'unix';

darkModeQuery.addEventListener('change', ({ matches }) => {
  document.documentElement.classList.toggle('dark', matches);
});

app.innerHTML = `
  <div class="site-shell">
    <header class="site-header">
      <a class="brand" href="/" aria-label="Klex home">
        <img class="klex-logo klex-logo-light" src="/klex-logo-light.svg" alt="Klex" />
        <img class="klex-logo klex-logo-dark" src="/klex-logo-dark.svg" alt="Klex" />
      </a>

      <nav class="site-nav" aria-label="Primary navigation">
        <a class="cloud-login" href="https://cloud.klex.bot">Cloud Login</a>
      </nav>
    </header>

    <main>
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-intro">
          <h1 id="hero-title">Meet Klex, your digital coworker.</h1>
        </div>

        <div class="installer" aria-label="Install Klex">
          <div class="installer-tabs" role="tablist" aria-label="Choose your operating system">
            <button class="installer-tab" type="button" role="tab" id="tab-unix" data-platform="unix" aria-controls="install-command-panel">
              Linux / macOS
            </button>
            <button class="installer-tab" type="button" role="tab" id="tab-windows" data-platform="windows" aria-controls="install-command-panel">
              Windows
            </button>
          </div>

          <div class="install-command" role="tabpanel" id="install-command-panel" aria-labelledby="tab-unix">
            <code id="install-command" tabindex="0"></code>
            <button
              class="copy-command"
              type="button"
              aria-label="Copy install command"
              title="Copy install command"
            >
              <svg class="copy-icon" aria-hidden="true" viewBox="0 0 18 18">
                <path d="M2.25 6.75v6.5a2 2 0 0 0 2 2h7.5" />
                <path d="M7.25 12.25h6.5a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2h-6.5a2 2 0 0 0-2 2v5.5a2 2 0 0 0 2 2Z" />
              </svg>
              <svg class="check-icon" aria-hidden="true" viewBox="0 0 18 18">
                <polyline points="2.75 9.25 6.75 14.25 15.25 3.75" />
              </svg>
            </button>
          </div>
        </div>

        <ul class="proof-list" aria-label="Klex product facts">
          <li>Apache 2.0 licensed</li>
          <li>Runs locally</li>
          <li>Works with any model</li>
        </ul>
      </section>
    </main>

    <footer class="site-footer">
      <div class="footer-credit">
        <span>Built with love by</span>
        <a class="stagewise-link" href="https://stagewise.io" target="_blank" rel="noreferrer" aria-label="stagewise">
          <img class="stagewise-wordmark" src="/stagewise-wordmark.svg" alt="stagewise" />
        </a>
      </div>

      <nav class="social-links" aria-label="Social links">
        <a href="https://x.com/stagewise_io" target="_blank" rel="noreferrer">X</a>
        <a href="https://linkedin.com/company/stagewise-io" target="_blank" rel="noreferrer">
          LinkedIn
        </a>
        <a href="https://github.com/stagewise-io/klex" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
    </footer>
  </div>
`;

const installerTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.installer-tab'),
);
const installCommand = document.querySelector<HTMLElement>('#install-command');
const installCommandPanel = document.querySelector<HTMLElement>(
  '#install-command-panel',
);
const copyCommand = document.querySelector<HTMLButtonElement>('.copy-command');

if (!installCommand || !installCommandPanel || !copyCommand) {
  throw new Error('Klex installer controls were not found.');
}

const installCommandElement = installCommand;
const copyCommandButton = copyCommand;
let copyAttempt = 0;
let copyResetTimer: number | undefined;

function resetCopyFeedback() {
  if (copyResetTimer !== undefined) {
    window.clearTimeout(copyResetTimer);
    copyResetTimer = undefined;
  }

  delete copyCommandButton.dataset.copied;
  delete copyCommandButton.dataset.copyFailed;
  copyCommandButton.setAttribute('aria-label', 'Copy install command');
  copyCommandButton.title = 'Copy install command';
}

function selectInstaller(platform: InstallerPlatform) {
  copyAttempt += 1;
  resetCopyFeedback();
  installCommandElement.textContent = installers[platform];

  for (const tab of installerTabs) {
    const selected = tab.dataset.platform === platform;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;

    if (selected && installCommandPanel) {
      installCommandPanel.setAttribute('aria-labelledby', tab.id);
    }
  }
}

for (const tab of installerTabs) {
  tab.addEventListener('click', () => {
    selectInstaller(tab.dataset.platform as InstallerPlatform);
  });

  tab.addEventListener('keydown', (event) => {
    const currentIndex = installerTabs.indexOf(tab);
    let nextIndex: number | undefined;

    if (event.key === 'ArrowLeft') {
      nextIndex =
        (currentIndex - 1 + installerTabs.length) % installerTabs.length;
    } else if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % installerTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = installerTabs.length - 1;
    }

    if (nextIndex === undefined) {
      return;
    }

    event.preventDefault();
    const nextTab = installerTabs[nextIndex];

    if (nextTab) {
      nextTab.focus();
      selectInstaller(nextTab.dataset.platform as InstallerPlatform);
    }
  });
}

async function copyText(command: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(command);
      return true;
    } catch {
      // Fall through to the synchronous selection-based fallback.
    }
  }

  const fallback = document.createElement('textarea');
  fallback.value = command;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.append(fallback);
  fallback.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    fallback.remove();
  }
}

function selectCommandText() {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(installCommandElement);
  selection?.removeAllRanges();
  selection?.addRange(range);
  installCommandElement.focus();
}

copyCommandButton.addEventListener('click', async () => {
  const command = installCommandElement.textContent ?? '';
  const currentAttempt = ++copyAttempt;
  resetCopyFeedback();
  const copied = await copyText(command);

  if (currentAttempt !== copyAttempt) {
    return;
  }

  if (copied) {
    copyCommandButton.dataset.copied = 'true';
    copyCommandButton.setAttribute('aria-label', 'Install command copied');
    copyCommandButton.title = 'Copied';
  } else {
    copyCommandButton.dataset.copyFailed = 'true';
    copyCommandButton.setAttribute('aria-label', 'Copy failed');
    copyCommandButton.title = 'Copy failed';
    selectCommandText();
  }

  copyResetTimer = window.setTimeout(resetCopyFeedback, copied ? 1800 : 5000);
});

selectInstaller(detectedPlatform);
