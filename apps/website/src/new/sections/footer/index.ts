import './footer.css';

import { buttonVariants } from '@stagewise/ui/src/components/ui/button.tsx';

export const footerMarkup = `
  <footer class="new-footer">
    <div class="new-footer-main">
      <h2>Make room for a new coworker.</h2>
      <a class="new-footer-cta ${buttonVariants({ size: 'lg' })}" data-slot="button" href="https://cloud.klex.bot">Create a Klex Bot</a>
    </div>
    <div class="new-footer-bottom">
      <div class="new-footer-about">
        <a class="new-brand" href="/" aria-label="Klex home">
          <img class="new-logo-light" src="/klex-logo-light.svg" alt="Klex" width="88" height="33" />
          <img class="new-logo-dark" src="/klex-logo-dark.svg" alt="Klex" width="88" height="33" />
        </a>
        <p class="new-footer-credit">
          <span>Built with love by</span>
          <a href="https://company.stagewise.io" target="_blank" rel="noreferrer">
            <img src="/stagewise-wordmark.svg" alt="stagewise" width="114" height="24" />
          </a>
        </p>
        <p class="new-footer-attribution">stagewise® and Klex® are registered trademarks of stagewise GmbH and protected in the EU by the European Union Intellectual Property Office (EUIPO).<br />Unauthorized use is prohibited.</p>
        <p class="new-footer-attribution">Third-party product names, logos, illustrations and brands referenced on this site are property of their respective owners. Use is for identification purposes only and does not imply any affiliation or endorsement.</p>
      </div>
      <nav aria-label="Resources">
        <h3>Resources</h3>
        <a href="https://docs.klex.bot">Docs</a>
        <a href="https://github.com/stagewise-io/klex">GitHub</a>
        <a href="https://company.stagewise.io/careers">Careers</a>
        <a href="/press">Press</a>
      </nav>
      <nav aria-label="Company">
        <h3>Company</h3>
        <a href="https://company.stagewise.io">stagewise</a>
        <a href="https://x.com/stagewise_io" target="_blank" rel="noreferrer">X</a>
        <a href="https://linkedin.com/company/stagewise-io" target="_blank" rel="noreferrer">LinkedIn</a>
      </nav>
    </div>
  </footer>
`;
