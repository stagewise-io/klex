import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { KlexBotCard, type KlexBotSelection } from './klex-bot-card';
import { jonathan } from './klex-bot-fixtures';

function render(selection: KlexBotSelection | null) {
  return renderToStaticMarkup(
    <KlexBotCard
      bot={jonathan}
      mascot={<span />}
      selection={selection}
      onActivate={() => {}}
    />,
  );
}

test.each([null, { botId: 'another-bot', integrationId: 'google' }])(
  'inactive connectors are disabled and identity details are not rendered: %j',
  (selection) => {
    const html = render(selection);
    const connectors = html.match(/<button[^>]*klex-card-connector[^>]*>/g)!;
    expect(connectors).toHaveLength(jonathan.integrations.length);
    for (const connector of connectors) {
      expect(connector).toContain('disabled=""');
      expect(connector).toContain('aria-pressed="false"');
      expect(connector).toContain('data-preview="false"');
      expect(connector).not.toContain('aria-describedby');
    }
    expect(html).not.toContain('klex-card-detail');
    expect(html).not.toContain('klex-card-identity');
    for (const identity of [
      jonathan.identity,
      ...jonathan.integrations.map((item) => item.identity),
    ]) {
      expect(html).not.toContain(identity);
    }
    expect(html).toMatch(/class="klex-card-select"(?![^>]*disabled)/);
  },
);

test('active connectors are enabled and only the locked connector is pressed', () => {
  const integration = jonathan.integrations[0];
  const html = render({ botId: jonathan.id, integrationId: integration.id });
  const connectors = html.match(/<button[^>]*klex-card-connector[^>]*>/g)!;
  expect(connectors.every((connector) => !connector.includes('disabled'))).toBe(
    true,
  );
  expect(
    connectors.filter((connector) => connector.includes('aria-pressed="true"')),
  ).toHaveLength(1);
  expect(html).toContain(
    `<p class="klex-card-identity">${integration.identity}</p>`,
  );
  expect(html).not.toContain('class="klex-card-detail" hidden');
});

test('active card without a locked connector renders the bot identity', () => {
  const html = render({ botId: jonathan.id, integrationId: null });
  expect(html).toContain('class="klex-card-detail"');
  expect(html).toContain(
    `<p class="klex-card-identity">${jonathan.identity}</p>`,
  );
});

test('the spin target expands and reveals identity while connectors remain inert', () => {
  const html = renderToStaticMarkup(
    <KlexBotCard
      bot={jonathan}
      mascot={<span />}
      selection={{ botId: jonathan.id, integrationId: null }}
      onActivate={() => {}}
      moving
      morphDuration={0.46}
    />,
  );
  expect(html).toContain('data-active="true"');
  expect(html).toContain('data-expanded="true"');
  expect(html).toMatch(/class="klex-card-select"[^>]*aria-pressed="true"/);
  expect(html.match(/class="klex-card-detail"/g)).toHaveLength(1);
  expect(html).toContain(jonathan.identity);
  const connectors = html.match(/<button[^>]*klex-card-connector[^>]*>/g)!;
  expect(
    connectors.every((connector) => connector.includes('disabled=""')),
  ).toBe(true);
});
