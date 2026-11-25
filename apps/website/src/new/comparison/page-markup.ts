import { headerMarkup } from '../navigation';
import { createFooterMarkup } from '../sections/footer';

// The comparison is currently available in English only.
export const comparisonMarkup =
  () => `${headerMarkup}<main id="main" class="resource-main comparison-main" lang="en" dir="ltr">
  <header class="resource-heading comparison-heading">
    <div class="comparison-heading-copy">
    <p class="comparison-eyebrow">Klex vs Rerun</p>
    <h1>Klex vs Rerun: choosing an AI coworker for your team</h1>
    <p>Say your team needs a weekly update: gather what shipped, draft the announcement and bring it to a person for review. Both Klex and Rerun offer AI coworkers that can help. The choice starts with where you want to work with them, how you want to provide their AI model, and how you will review actions.</p>
    <p>Klex puts digital coworkers alongside your team in connected tools. Rerun offers ready-made and custom coworkers with a shared board for their work. Both describe cloud and self-hosted options.</p>
    </div>
    <aside class="comparison-at-a-glance" aria-labelledby="comparison-at-a-glance-title">
      <p class="comparison-card-label" id="comparison-at-a-glance-title">At a glance</p>
      <div><h2>Klex</h2><p>A digital coworker in your team’s connected tools, using the model access you provide.</p></div>
      <div><h2>Rerun</h2><p>AI coworkers with a shared board and a choice of Rerun-hosted or your own models.</p></div>
    </aside>
  </header>
  <section class="resource-section" id="getting-started">
    <h2>One job, two ways to get started</h2>
    <div class="resource-section-body">
      <p>With Klex, you can give a coworker access to the tools the job needs and work with it in places such as Slack and GitHub. <a href="https://www.klex.bot/">Klex describes bots using their own identities in those apps</a>. Identity and permissions depend on the connector and setup. In this example, a team member asks the bot in Slack to gather changes from a connected source and bring back a draft for review.</p>
      <p>With Rerun, you can choose a ready-made role or create a coworker and use its shared board to see work and respond to requests. <a href="https://rerun.build/">Rerun describes connections to apps, schedules and coworker handoffs</a>. In this example, a team member chooses or creates a coworker, connects a source and reviews its draft on the shared board.</p>
      <p>These examples are illustrative. Check that your sources and review steps work with your setup.</p>
    </div>
  </section>
  <section class="resource-section" id="models">
    <h2>Where will the AI model come from?</h2>
    <div class="resource-section-body">
      <p class="comparison-question">Do I need to arrange model access separately?</p>
      <div class="comparison-pair">
        <div><h3>Klex</h3><p>Bring your own model access. The <a href="https://docs.klex.bot/quickstart">Klex quickstart</a> describes provider APIs, supported subscriptions, local providers and custom endpoints. Provider costs or plan limits are separate from hosting.</p></div>
        <div><h3>Rerun Pro</h3><p><a href="https://docs.rerun.build/billing">Pro includes 500 monthly credits</a> shared between Rerun-hosted models and paid data. You can also <a href="https://docs.rerun.build/agents/configure">bring your own model access</a>. Extra credits and outside provider costs are separate.</p></div>
      </div>
    </div>
  </section>
  <section class="resource-section" id="cost">
    <h2>What will it cost?</h2>
    <div class="resource-section-body">
      <p><a href="https://rerun.build/pricing">Rerun lists Pro at $29 per month before tax</a>, with unlimited coworkers and seats. The 500 included monthly credits are shared by Rerun models and paid data, and reset each month. Extra credits and some app slots can add cost. Rerun also advertises <a href="https://rerun.build/lifetime">a one-time $80 lifetime offer</a> for one workspace with no included credits.</p>
      <p>Each Klex bot costs $10 in credits per month. Model access is supplied separately, and provider charges or plan limits apply. If you run Klex on your own infrastructure, include the cost of that infrastructure and your model provider.</p>
      <p>For a useful comparison, estimate one month of the same job: number of coworkers, hosting, model usage, paid data and any app charges. Published starting prices do not tell you the total for that workload.</p>
    </div>
  </section>
  <section class="resource-section" id="review">
    <h2>Who reviews the work?</h2>
    <div class="resource-section-body">
      <p>In Klex, the connected app’s permissions determine what the coworker can access. You can give it instructions and skills about when to ask for confirmation. Klex currently has no product-enforced action-by-action approval queue, so choose permissions and a review process suited to the work.</p>
      <p><a href="https://rerun.build/features/human-in-the-loop">Rerun says spending is product-locked</a>, while Rerun describes sending and deleting as governed by coworker instructions. <a href="https://rerun.build/changelog">Its paid-data settings include an always-allow option</a>, and its optional Autopilot can answer under rules you write. Review the settings for the actions you plan to delegate.</p>
    </div>
  </section>
  <section class="resource-section" id="fit">
    <h2>Which is a better fit?</h2>
    <div class="resource-section-body">
      <p>Choose Klex when working alongside your team in existing tools is the priority and you want to supply your own model access. <a href="https://www.klex.bot/">Klex describes Cloud-hosted bots</a>, and its <a href="https://docs.klex.bot/quickstart">quickstart describes self-hosting</a>.</p>
      <p>Consider Rerun when a shared board and ready-made roles fit how your team wants to start. Rerun Pro also includes model credits. <a href="https://docs.rerun.build/self-host/open-source-vs-cloud">Its self-hosted edition differs from its managed service</a>: Rerun says the self-hosted edition lacks the hosted template library and included model credit.</p>
    </div>
  </section>
  <section class="resource-section" id="try">
    <h2>Try one workflow</h2>
    <div class="resource-section-body">
      <p>Pick the task you would delegate first. Check its connected apps, who can review the result and what a month of model and hosting usage would cost. <a href="https://www.klex.bot/">Explore Klex</a> to see how its coworkers work.</p>
    </div>
  </section>
</main>
${createFooterMarkup({ showCta: false })}`;
