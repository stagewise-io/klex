import { configV4Schema } from './v4';
import { configV5Schema } from './v5';
import { preservingSchema } from './validation';

export const configV4 = {
  version: 4,
  schema: preservingSchema((value) => configV4Schema.parse(value)),
};
export const configV5 = {
  version: 5,
  schema: preservingSchema((value) => configV5Schema.parse(value)),
};
