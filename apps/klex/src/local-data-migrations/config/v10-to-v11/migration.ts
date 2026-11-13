import type { JsonMigration } from '@/local-data';

import { configV10Schema } from './v10';
import { configV11Schema } from './v11';

export const configV10ToV11: JsonMigration = {
  from: 10,
  to: 11,
  name: 'add-mcp-event-subscriptions',
  up: (value) => {
    configV10Schema.parse(value);
    configV11Schema.parse(value);
    return structuredClone(value);
  },
};
