import './trust.css';

import { buttonVariants } from '@stagewise/ui/src/components/ui/button.tsx';

import { officeMarkup } from './office';

export { mountTrust } from './principles';

export const trustMarkup = `
  <section class="new-trust" id="trust" aria-labelledby="trust-title">
    <div class="trust-content">
      <header class="trust-intro">
        <h2 id="trust-title">How teams work with Klex Bots</h2>
        <p>Who better to show you how Klex Bots work in real organizations than the team behind them? Hover over a Klex Bot to see what they do.</p>
      </header>

      ${officeMarkup}

      <section class="trust-safety" aria-labelledby="trust-safety-title">
        <header class="trust-safety-intro">
          <h3 id="trust-safety-title">Bots you can trust.</h3>
        </header>
        <div class="trust-principles">
          <article>
            <div class="trust-principle-scene" data-trust-scene="open" aria-hidden="true"></div>
            <h4>Open source and self-hostable</h4>
            <p>Run Klex on your own infrastructure and keep control of your data, or get started in seconds with our cloud-hosted bots.</p>
            <a href="https://github.com/stagewise-io/klex">View on GitHub <span aria-hidden="true">↗</span></a>
          </article>
          <article>
            <div class="trust-principle-scene" data-trust-scene="isolated" aria-hidden="true"></div>
            <h4>Isolated by default</h4>
            <p>Bots have no direct access to your machine. You choose which apps and computers or sandboxes they can use. Everything is connected via MCP.</p>
          </article>
          <article>
            <div class="trust-principle-scene" data-trust-scene="memory" aria-hidden="true"></div>
            <h4>Updates that just work</h4>
            <p>Klex Bots don't break when you update them. They keep their memory and skills and just get better.</p>
          </article>
        </div>
        <section class="trust-center" aria-labelledby="cloud-compliance-title">
          <div class="trust-center-copy">
            <h4 id="cloud-compliance-title">Klex Cloud security &amp; compliance</h4>
            <div class="trust-center-compliance">
              <p class="trust-center-status">
                <span class="trust-center-status-name">SOC 2 Type 2</span>
                <span class="trust-center-status-progress">Audit underway</span>
              </p>
              <p class="trust-center-status">
                <span class="trust-center-status-name">ISO 27001</span>
                <span class="trust-center-status-progress">Certification underway</span>
              </p>
            </div>
          </div>
          <p class="trust-center-action">
            <a class="trust-center-cta ${buttonVariants({ variant: 'secondary', size: 'lg' })}" data-slot="button" href="https://trust.stagewise.io">Visit the Cloud Trust Center</a>
          </p>
        </section>
      </section>
    </div>
  </section>
`;
