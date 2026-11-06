import { html } from '../../../i18n/index.ts';

export function createFooterMarkup({
  showCta = false,
  buttonClass = '',
}: {
  showCta?: boolean;
  buttonClass?: string;
} = {}): string {
  return `
  <footer class="new-footer">
    ${
      showCta
        ? `<div class="new-footer-main">
      <h2>${html('Make room for a new coworker.')}</h2>
      <a class="new-footer-cta ${buttonClass}" data-slot="button" href="https://cloud.klex.bot">${html('Create a Klex Bot')}</a>
    </div>`
        : ''
    }
    <div class="new-footer-bottom">
      <div class="new-footer-about">
        <a class="new-brand" href="/" aria-label="${html('Klex home')}">
          <img class="new-logo-light" src="/klex-logo-light.svg" alt="Klex" width="88" height="33" />
          <img class="new-logo-dark" src="/klex-logo-dark.svg" alt="Klex" width="88" height="33" />
        </a>
        <p class="new-footer-credit">
          <span>${html('Built with love by')}</span>
          <a href="https://company.stagewise.io" target="_blank" rel="noreferrer">
            <img src="/stagewise-wordmark.svg" alt="stagewise" width="114" height="24" />
          </a>
        </p>
        <div class="new-footer-utilities">
        <a class="new-footer-status" href="https://status.klex.bot/" data-cloud-status data-state="unknown">
          <span class="new-footer-status-dot" aria-hidden="true"></span>
          <span data-cloud-status-label aria-live="polite">${html('Klex Cloud status')}</span>
        </a>
        <div class="new-language-mount"></div>
        </div>
        <p class="new-footer-attribution">Klex® and stagewise® are registered trademarks of stagewise GmbH and protected in the EU by the European Union Intellectual Property Office (EUIPO).<br />Unauthorized use is prohibited.</p>
        <p class="new-footer-attribution">Third-party product names, logos, illustrations and brands referenced on this site are property of their respective owners. Use is for identification purposes only and does not imply any affiliation or endorsement.</p>
      </div>
      <nav aria-label="${html('Resources')}">
        <h3>${html('Resources')}</h3>
        <a href="https://docs.klex.bot">${html('Docs')}</a>
        <a href="https://github.com/stagewise-io/klex">GitHub</a>
        <a href="https://company.stagewise.io/careers">${html('Careers')}</a>
        <a href="/press">${html('Press')}</a>
      </nav>
      <nav aria-label="${html('Company')}">
        <h3>${html('Company')}</h3>
        <a href="https://company.stagewise.io">stagewise</a>
        <a href="/legal/privacy">${html('Privacy Policy')}</a>
        <a href="/legal/terms">${html('Terms of Service')}</a>
        <a href="/legal">${html('Legal Center')}</a>
        <a href="mailto:support@klex.bot">${html('Support')}</a>
        <a href="https://x.com/stagewise_io" target="_blank" rel="noreferrer">X</a>
        <a href="https://linkedin.com/company/stagewise-io" target="_blank" rel="noreferrer">LinkedIn</a>
      </nav>
    </div>
  </footer>
`;
}
