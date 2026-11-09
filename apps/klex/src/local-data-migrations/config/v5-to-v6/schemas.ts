import { configV5Schema } from './v5';
import { configV6Schema } from './v6';
import { preservingSchema } from './validation';

export const configV5 = {
  version: 5,
  schema: preservingSchema((value) => configV5Schema.parse(value)),
};
export const configV6 = {
  version: 6,
  schema: preservingSchema((value) => configV6Schema.parse(value)),
};
