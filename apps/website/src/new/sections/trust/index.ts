import './trust.css';

import { buttonVariants } from '@stagewise/ui';

import { html } from '@/i18n';

import { officeMarkup } from './office';

export const trustMarkup = `
  <section class="new-trust" id="trust" aria-labelledby="trust-title">
    <div class="trust-content">
      <header class="trust-intro">
        <h2 id="trust-title">${html('How teams work with Klex Bots')}</h2>
        <p>${html('Who better to show you how Klex Bots work in real organizations than the team behind them?')} <span data-markdown="exclude">${html('Hover over a Klex Bot to see what they do.')}</span></p>
      </header>

      ${officeMarkup}

      <section class="trust-safety" aria-labelledby="trust-safety-title">
        <header class="trust-safety-intro">
          <h3 id="trust-safety-title">${html('Bots you can trust.')}</h3>
        </header>
        <div class="trust-principles">
          <article>
            <div class="trust-principle-scene" data-trust-scene="open" aria-hidden="true"></div>
            <h4>${html('Open source and self-hostable')}</h4>
            <p>${html('Run Klex on your own infrastructure and keep control of your data, or get started in seconds with our cloud-hosted bots.')}</p>
            <a href="https://github.com/stagewise-io/klex">${html('View on GitHub')} <span aria-hidden="true">↗</span></a>
          </article>
          <article>
            <div class="trust-principle-scene" data-trust-scene="isolated" aria-hidden="true"></div>
            <h4>${html('Isolated by default')}</h4>
            <p>${html('Bots have no direct access to your computer. You choose which apps and computers or sandboxes they can use. Everything is connected via MCP.')}</p>
          </article>
          <article>
            <div class="trust-principle-scene" data-trust-scene="memory" aria-hidden="true"></div>
            <h4>${html('Updates that just work')}</h4>
            <p>${html("Klex Bots don't break when you update them. They keep their memory and skills and just get better.")}</p>
          </article>
        </div>
        <section class="trust-center" aria-labelledby="cloud-compliance-title">
          <div class="trust-center-copy">
            <h4 id="cloud-compliance-title">${html('Klex Cloud security & compliance')}</h4>
            <div class="trust-center-compliance">
              <p class="trust-center-status">
                <span class="trust-center-status-name" data-markdown-text="SOC 2 Type 2:">SOC 2 Type 2</span>
                <span class="trust-center-status-progress">${html('Audit underway')}</span>
              </p>
              <p class="trust-center-status">
                <span class="trust-center-status-name" data-markdown-text="ISO 27001:">ISO 27001</span>
                <span class="trust-center-status-progress">${html('Certification underway')}</span>
              </p>
            </div>
          </div>
          <p class="trust-center-action">
            <a class="trust-center-cta ${buttonVariants({ variant: 'secondary', size: 'lg' })}" data-slot="button" href="https://trust.stagewise.io">${html('Visit the Cloud Trust Center')}</a>
          </p>
        </section>
      </section>
    </div>
  </section>
`;
