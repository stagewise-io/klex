import { describe, expect, it, vi } from 'vitest';

import { CHECKPOINT_DATA_PART_TRANSFORMERS } from '../checkpoint';
import {
  blockPartTransformer,
  type ExtensionDeps,
} from '../extensions/extension-api';
import { projectOpenResourcesData } from '../extensions/mcp-ingress/open-resources-tracker';
import { projectServerListData } from '../extensions/mcp-ingress/server-list-tracker';
import { projectWatchedEventsData } from '../extensions/mcp-ingress/watched-events-tracker';
import { createTimeExt } from '../extensions/time/time';
import type { ExtendedUIMessage } from '../message-types';
import { convertToModelMessagesExtended } from './convert-to-model-messages';

vi.mock('../extensions/time/system-prompt.md', () => ({
  default: 'Time context',
}));

describe('model-facing context format', () => {
  it('renders stored baselines, updates and checkpoint context without XML wrappers', async () => {
    const time = createTimeExt({
      timezone: 'UTC',
      timeUpdatePeriod: 300,
    }).create({} as ExtensionDeps);
    const server = {
      name: 'github',
      status: 'connected',
      toolCount: 12,
      resourceCount: 0,
    };
    const parts = [
      {
        type: 'data-availableSkills',
        data: [{ name: 'testing', description: 'Run tests' }],
      },
      { type: 'data-time', data: { timestamp: 1_776_007_800, tz: 'UTC' } },
      { type: 'data-timezone', data: { timestamp: 1_776_007_800, tz: 'UTC' } },
      {
        type: 'data-mcp-server-list',
        data: { isInitial: true, servers: [server] },
      },
      {
        type: 'data-mcp-server-list',
        data: {
          isInitial: false,
          servers: [],
          diff: { added: [], changed: [], removed: ['github'] },
        },
      },
      {
        type: 'data-mcp-open-resources',
        data: { isInitial: true, resources: [] },
      },
      {
        type: 'data-mcp-open-resources',
        data: {
          isInitial: false,
          resources: [],
          diff: { added: [], changed: [], removed: ['resource-1'] },
        },
      },
      {
        type: 'data-mcp-watched-events',
        data: { isInitial: true, watches: [] },
      },
      {
        type: 'data-mcp-watched-events',
        data: {
          isInitial: false,
          watches: [],
          diff: { added: [], changed: [], removed: ['watch-1'] },
        },
      },
      { type: 'data-context-summary', data: { summary: 'Earlier context' } },
    ];
    const history = [
      { id: 'stored-context', role: 'user', parts },
    ] as unknown as ExtendedUIMessage[];
    const transformers = {
      ...CHECKPOINT_DATA_PART_TRANSFORMERS,
      ...time.dataPartTransformers,
      'mcp-server-list': blockPartTransformer(projectServerListData),
      'mcp-open-resources': blockPartTransformer(projectOpenResourcesData),
      'mcp-watched-events': blockPartTransformer(projectWatchedEventsData),
    };

    // Repeated conversion exercises restored history, not just newly emitted parts.
    for (let pass = 0; pass < 2; pass++) {
      const messages = await convertToModelMessagesExtended(
        history,
        transformers,
      );
      const text = messages
        .flatMap((message) =>
          typeof message.content === 'string'
            ? [message.content]
            : message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text),
        )
        .join('\n\n');
      for (const label of [
        'available-skills',
        'time',
        'timezone',
        'mcp-servers',
        'mcp-servers-diff',
        'open-resources',
        'open-resources-diff',
        'watched-mcp-events',
        'watched-mcp-events-diff',
        'summary',
      ]) {
        expect(text).toMatch(new RegExp(`(?:^|\\n\\n)# ${label}(?:\\n| )`));
      }
      expect(text).toContain(
        '# available-skills\n| name | description |\n| testing | Run tests |',
      );
      expect(text).toContain('# time Sunday, 12.4.2026, 15:30');
      expect(text).toContain('# timezone UTC, UTC, +00:00');
      expect(text).not.toMatch(
        /<\/?(?:available-skills|time|timezone|mcp-servers?|mcp-servers?-diff|open-resources|watched-mcp-events|summary)[\s>]/,
      );
      expect(text).not.toContain('| --- |');
      expect(text).toContain('# open-resources\n[]');
      expect(text).toContain('# watched-mcp-events\n[]');
      expect(text).toContain('removed: |\n  - resource-1');
      expect(text).toContain('removed: |\n  - watch-1');
    }
  });
});
