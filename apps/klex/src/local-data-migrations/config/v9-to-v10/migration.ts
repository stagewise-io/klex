import type { JsonMigration } from '@/local-data';

import { configV9Schema } from './v9';
import { configV10Schema } from './v10';

export const configV9ToV10: JsonMigration = {
  from: 9,
  to: 10,
  name: 'add-optional-effort-policy',
  up: (value) => {
    configV9Schema.parse(value);
    configV10Schema.parse(value);
    return structuredClone(value);
  },
};
