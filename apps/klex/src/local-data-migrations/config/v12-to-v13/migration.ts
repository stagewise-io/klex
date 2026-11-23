import type { JsonMigration } from '@/local-data';

import { configV12Schema } from './v12';
import { configV13Schema } from './v13';
export const configV12ToV13: JsonMigration = {
  from: 12,
  to: 13,
  name: 'add-langdock-provider',
  up: (value) => {
    configV12Schema.parse(value);
    const next = structuredClone(value);
    configV13Schema.parse(next);
    return next;
  },
};
