import type { JsonMigration } from '@/local-data';

import { configV13Schema } from './v13';
import { configV14Schema } from './v14';
export const configV13ToV14: JsonMigration = {
  from: 13,
  to: 14,
  name: 'add-klex-cloud-provider',
  up: (value) => {
    configV13Schema.parse(value);
    const next = structuredClone(value);
    configV14Schema.parse(next);
    return next;
  },
};
