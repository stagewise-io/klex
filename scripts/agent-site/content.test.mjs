import { expect, it } from 'vitest';

import { createSiteContent } from './content.mjs';

it('appends footer links outside main, deduplicates URLs and retains image-link labels', () => {
  const result = createSiteContent().markdown(
    '<main><h1>Product</h1></main><footer><a href="/" aria-label="Klex home"><img alt="Klex"></a><a href="https://company.stagewise.io"><img alt="stagewise"></a><a href="https://status.klex.bot/" data-cloud-status>All systems operational</a><nav><a href="/press">Press</a><a href="https://company.stagewise.io">Company</a></nav></footer>',
    'https://www.klex.bot/',
  );
  expect(result).toContain('## Footer links');
  expect(result).toContain('[Klex Cloud status](https://status.klex.bot/)');
  expect(result).toContain('[stagewise](https://company.stagewise.io/)');
  expect(result).toContain('[Press](https://www.klex.bot/press)');
  expect(result.match(/https:\/\/company\.stagewise\.io\//g)).toHaveLength(1);
  expect(result).not.toContain('All systems operational');
  expect(result).not.toContain('Canonical:');
  expect(result.trimEnd()).toMatch(/\)$/);
});

const markdown = (html) =>
  createSiteContent().markdown(`<main>${html}</main>`, 'https://www.klex.bot/');

it('preserves ordered lists and includes explicitly marked inactive narrative, not controls', () => {
  const result = markdown(
    '<h1>Product</h1><div data-markdown="exclude"><button>01020304</button></div><ol><li><h2>First</h2><p>Start</p></li><li><h2>Second</h2><div aria-hidden="true" inert data-markdown="include"><p>Finish</p></div></li></ol>',
  );
  expect(result).toContain('1. ## First');
  expect(result).toContain('2. ## Second');
  expect(result).toContain('Finish');
  expect(result).not.toContain('01020304');
});

it('clarifies scoped bot names and step headings without changing unrelated names', () => {
  const result = markdown(
    '<p>Monica outside the workflow.</p><section data-markdown-bot-names="Monica,Jeff"><ol data-markdown-layout="sections"><li><h3 data-markdown-text="Step 1: Request — Monica starts">Visible title</h3><p>Monica asks Jeff. Jeff (Klex Bot) tests.</p></li><li><h3>Step 2</h3><p data-markdown="include" aria-hidden="true">Jeff reports.</p></li></ol></section>',
  );
  expect(result).toContain('### Step 1: Request — Monica (Klex Bot) starts');
  expect(result).toContain(
    'Monica (Klex Bot) asks Jeff (Klex Bot). Jeff (Klex Bot) tests.',
  );
  expect(result).not.toContain('(Klex Bot) (Klex Bot)');
  expect(result).toContain('Monica outside the workflow.');
  expect(result).not.toContain('Visible title');
  expect(result).toContain('Jeff (Klex Bot) reports.');
  expect(result).not.toContain('1. ###');
});

it('keeps comparison cell-to-column relationships and caption boundaries', () => {
  const result = markdown(
    '<table><caption>Compare</caption><thead><tr><th>Assistant</th><th>Klex Bots</th></tr></thead><tbody><tr><th colspan="2"><h2>Identity</h2></th></tr><tr><td><strong>Shared account</strong><p>Uses yours</p></td><td><strong>Own account</strong><p>Acts independently</p></td></tr></tbody></table>',
  );
  expect(result).toContain('Compare\n\n');
  expect(result).toContain('**Assistant:** **Shared account**');
  expect(result).toContain('**Klex Bots:** **Own account**');
  expect(result).not.toContain('CompareAssistant');
});

it('includes content navigation only when opted in and still excludes decorative children', () => {
  const result = markdown(
    '<nav>Site menu</nav><nav data-markdown="include"><h2>Guides</h2><ul><li><a href="/guide">Read guide<span aria-hidden="true">→</span></a></li></ul></nav>',
  );
  expect(result).toContain('## Guides');
  expect(result).toContain('[Read guide](https://www.klex.bot/guide)');
  expect(result).not.toContain('Site menu');
  expect(result).not.toContain('→');
});
