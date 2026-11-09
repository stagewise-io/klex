import { configV8Schema } from './v8';
import { preservingSchema } from './validation';

export const configV8 = {
  version: 8,
  schema: preservingSchema((value) => configV8Schema.parse(value)),
};
