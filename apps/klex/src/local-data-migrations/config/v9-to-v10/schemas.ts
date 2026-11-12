import { configV10Schema } from './v10';
import { preservingSchema } from './validation';

export const configV10 = {
  version: 10,
  schema: preservingSchema((value) => configV10Schema.parse(value)),
};
