import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { getScenario, scenarioRegistry } from './connector-scenarios';
import { ConnectorPanels, connectorShells } from './connector-shells';
import { botFixtures } from './klex-bot-fixtures';

test('every selectable pair has content and exactly one accessible panel', () => {
  for (const bot of botFixtures)
    for (const connector of bot.integrations) {
      const scenario = scenarioRegistry[`${bot.id}:${connector.id}`];
      expect(scenario.messages.length).toBeGreaterThan(0);
      expect(scenario.botId).toBe(bot.id);
      const html = renderToStaticMarkup(
        <ConnectorPanels
          selection={{ botId: bot.id, integrationId: connector.id }}
        />,
      );
      expect(html.match(/aria-current="true"/g)).toHaveLength(1);
      expect(html.match(/aria-hidden="false"/g)).toHaveLength(1);
      expect(html).toContain(scenario.title);
    }
});
test('unknown bots retain the requested connector shell and useful fallback content', () => {
  for (const id of Object.keys(connectorShells)) {
    const data = getScenario('unknown-bot', id);
    expect(data.connectorId).toBe(id);
    expect(data.messages[0].author.name).toBe('Klex coworker');
    expect(data.title.length).toBeGreaterThan(10);
  }
  expect(getScenario('unknown-bot', 'unknown-connector').connectorId).toBe(
    'slack',
  );
  expect(getScenario('unknown-bot', 'constructor').connectorId).toBe('slack');
});
